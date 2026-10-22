import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  BadRequestException,
  InternalException,
  NotFoundException,
} from '@packages/common';

import type { HostWake } from '../../agents/chat.types';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ArtifactPageService } from '../../agents/services/artifact-page.service';
import { ArtifactStoreService } from '../../agents/services/artifact-store.service';
import { HostWakeBus } from '../../agents/services/host-wake.bus';
import type { ManagedCommandResult } from '../../agents/utils/managed-command';
import { ArtifactShareDao } from '../dao/artifact-share.dao';
import type { ArtifactShare } from '../entity/artifact-share.entity';
import {
  type AgentShareOutcome,
  type DestinationCommand,
  type RevokeOutcome,
  type Share,
  SHARE_COMMAND_RUNNER,
  type ShareActor,
  type ShareAsker,
  type ShareCheckResult,
  type ShareCommandRunner,
  type ShareConfig,
  type ShareDestination,
  ShareDestinationSchema,
  type ShareSignInLabel,
  type ShareStatus,
  type ShareThemeVars,
} from '../shares.types';
import { buildPortableArtifact } from '../utils/portable-artifact';
import {
  authProfileOf,
  classifyShareFailure,
  type ShareAuthProfile,
  type ShareFailureCause,
} from '../utils/share-auth';
import {
  destinationArgv,
  linkFor,
  mintObjectId,
  PROBE_EMPTY,
  probeArgv,
  removeFoundNothing,
} from '../utils/share-destinations';
import { buildShareEnvelope, mintShareKey } from '../utils/share-envelope';
import { ShareEventBus } from './share-events.bus';
import { ShareKeychain } from './share-keychain.service';

const UPLOAD_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 30_000;

const KEY_MISSING =
  'the key for this link is no longer in the Keychain — revoke it and share the page again';
const NO_DEFAULT_DESTINATION =
  'no default place to share to is set in Settings → Sharing';
const PAGE_GONE = 'this page is no longer stored, so it cannot be shared';
const PLACE_REMOVED =
  'the place it was being shared to was removed from Settings → Sharing';

interface ShareInput {
  runId: string;
  artifactId: string;
  title: string;
  by: ShareActor;
  destinationId?: string;
  themeVars?: ShareThemeVars;
  /** The agent conversation asking, when an agent asks. */
  asker?: ShareAsker;
}

type Attempt =
  { ok: true } | { ok: false; cause: ShareFailureCause; detail: string };

/**
 * Shares artifacts as end-to-end-encrypted links on a destination the user
 * configured — the daemon side of Settings → Sharing and of
 * `show_artifact(share: true)`.
 *
 * The page is encrypted here, on the Mac, and only the envelope is uploaded,
 * through the user's own CLI and login; the key lives in the Keychain and in
 * the link's fragment. geniro runs no server and holds no credential.
 *
 * A share that fails because the destination's CLI is signed out is kept as
 * `awaiting-sign-in`, its key minted already so the link it will have is
 * fixed, and tried again once after the user signs in ({@link retryAwaiting}).
 * An agent that asked for it is woken with the outcome (`HostWakeBus`).
 *
 * The configuration is pushed by Electron main (which owns settings.json) on
 * every daemon start and after every settings write, and is held in memory
 * only. Until the first push nothing can be shared, by anyone.
 */
@Injectable()
export class ShareService implements OnModuleInit {
  private readonly logger = new Logger(ShareService.name);
  private config: ShareConfig | null = null;
  private configReceivedAt: Date | null = null;
  /**
   * The theme of the last press, reused for an agent's share: the daemon has
   * no window to read a theme from, and the last one the user looked at is the
   * best stand-in. Null until a press; the page then takes its light defaults.
   */
  private lastThemeVars: ShareThemeVars | null = null;
  /** The boot sweep came before the first settings push and waits for it. */
  private sweepOnConfig = false;
  /** One operation per share at a time, keyed by `<runId>/<artifactId>`. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dao: ArtifactShareDao,
    private readonly store: ArtifactStoreService,
    private readonly pages: ArtifactPageService,
    private readonly keychain: ShareKeychain,
    @Inject(SHARE_COMMAND_RUNNER) private readonly run: ShareCommandRunner,
    private readonly events: ShareEventBus,
    private readonly wakes: HostWakeBus,
    private readonly runs: AgentEventBus,
  ) {}

  onModuleInit(): void {
    this.runs.allDeleted().subscribe((runId) => {
      void this.dropPending({ runId }, 'deleted');
    });
    // Fired for renames, pins and unarchives too: only an archive drops.
    this.runs.allChanged().subscribe((changed) => {
      for (const run of changed) {
        if (run.archivedAt !== null && run.archivedAt !== undefined) {
          void this.dropPending({ runId: run.id }, 'archived');
        }
      }
    });
  }

  setConfig(config: ShareConfig): { receivedAt: string } {
    this.config = config;
    this.configReceivedAt = new Date();
    // On every push with the switch off, the first after a restart included:
    // an agent's share left waiting by an earlier daemon is no less refused.
    if (!config.agentsMayShare) {
      void this.dropPending({ askedByAgent: true }, 'agents-off');
      void this.withdrawUnsentLinks();
    }
    const sweep = this.sweepOnConfig;
    this.sweepOnConfig = false;
    // In order: a share the orphan pass settles is woken by it, never again
    // by the boot sweep it would otherwise race.
    void this.settleOrphans(config).then(() =>
      sweep ? this.republishOwedWakes() : undefined,
    );
    return { receivedAt: this.configReceivedAt.toISOString() };
  }

  /**
   * The switch went off: every uploaded share still owing its askers the
   * link forgets them, so no wake, held or owed at a boot, ever carries it.
   */
  private async withdrawUnsentLinks(): Promise<void> {
    try {
      for (const row of await this.dao.listOwedWakes()) {
        if (row.status !== 'live') {
          continue;
        }
        await this.locked(`${row.runId}/${row.artifactId}`, async () => {
          const fresh = await this.dao.getById(row.id);
          if (fresh?.status === 'live' && fresh.agentToldAt === null) {
            await this.write(fresh, { asker: null });
          }
        });
      }
    } catch (err) {
      this.logger.warn(`could not withdraw unsent share links: ${String(err)}`);
    }
  }

  get receivedAt(): string | null {
    return this.configReceivedAt?.toISOString() ?? null;
  }

  async list(runId?: string): Promise<Share[]> {
    return (await this.dao.list(runId)).map((row) => this.toWire(row));
  }

  async link(id: string): Promise<{ url: string }> {
    const row = await this.dao.getById(id);
    if (row === null) {
      throw new NotFoundException('SHARE_NOT_FOUND', 'no such shared page');
    }
    if (row.sharedVersion === 0) {
      throw new NotFoundException(
        'SHARE_NOT_UPLOADED',
        'this page has not been shared yet, so it has no link',
      );
    }
    const key = await this.keychain.read(row.id);
    if (key === null) {
      throw new NotFoundException('SHARE_KEY_MISSING', KEY_MISSING);
    }
    return { url: linkFor(this.destinationOf(row), row.objectId, key) };
  }

  /**
   * Upload the artifact's newest version. Sharing a page already shared
   * re-uploads to the same object under the same key, so the link already
   * handed out keeps working and shows the newer version.
   *
   * A destination whose CLI is signed out answers a share left
   * `awaiting-sign-in` with no link (`url: null`); any other failure throws.
   */
  share(input: ShareInput): Promise<{ share: Share; url: string | null }> {
    return this.locked(`${input.runId}/${input.artifactId}`, () =>
      this.shareUnlocked(input),
    );
  }

  /**
   * An agent's `show_artifact(share: true)`. Never throws: whatever stops the
   * share becomes a reason the agent is told, and the publish it rode on
   * stands either way. A signed-out destination keeps the agent as the
   * share's asker, woken with the link once the user signs in.
   */
  async shareForAgent(
    input: Omit<ShareInput, 'by' | 'destinationId' | 'themeVars'>,
    viaRemote: boolean,
  ): Promise<AgentShareOutcome> {
    const refusal = this.agentRefusal(viaRemote);
    // A page already shared goes back to the place its row names, so a
    // default place unset since is no reason to refuse it — while that place
    // is still in Settings.
    const existing =
      refusal === NO_DEFAULT_DESTINATION
        ? await this.dao.findByArtifact(input.runId, input.artifactId)
        : null;
    const ownPlace =
      existing !== null && this.isConfigured(this.destinationIdOf(existing));
    if (refusal !== null && !ownPlace) {
      return { kind: 'not-shared', reason: refusal };
    }
    try {
      const { share, url } = await this.share({ ...input, by: 'agent' });
      if (url === null) {
        return {
          kind: 'awaiting-sign-in',
          label: share.signIn?.label ?? share.destinationName,
        };
      }
      return { kind: 'shared', url };
    } catch (error) {
      return {
        kind: 'not-shared',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Whether an agent may share right now — read by the tool's own description too. */
  agentsMayShare(): boolean {
    return this.agentRefusal(false) === null;
  }

  /** A destination in the pushed settings, or null when there is none by that id. */
  destination(id: string): ShareDestination | null {
    return this.config?.destinations.find((d) => d.id === id) ?? null;
  }

  async revoke(id: string): Promise<RevokeOutcome> {
    const found = await this.dao.getById(id);
    if (found === null) {
      throw new NotFoundException('SHARE_NOT_FOUND', 'no such shared page');
    }
    return this.locked(`${found.runId}/${found.artifactId}`, async () => {
      // Read again under the lock: a revoke queued behind another one finds
      // the row already gone.
      const row = await this.dao.getById(id);
      if (row === null) {
        return { status: 'revoked' };
      }
      // Nothing was ever uploaded, so there is nothing remote to delete —
      // and no destination to read, which could refuse the revoke.
      if (row.sharedVersion === 0) {
        await this.removeRow(row);
        return { status: 'revoked' };
      }
      const destination = this.destinationOf(row);
      const result = await this.run({
        ...destinationArgv(destination, 'remove', { objectId: row.objectId }),
        label: 'share:revoke',
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
      if (result.code !== 0 && !removeFoundNothing(destination, result)) {
        const detail = failureOf(result);
        await this.write(row, { status: 'revoke-failed', lastError: detail });
        return { status: 'revoke-failed', detail };
      }
      // Remote first, then the key: a key deleted while the object survived
      // would leave a live link nobody could ever revoke from here.
      await this.removeRow(row);
      return { status: 'revoked' };
    });
  }

  /**
   * Whether a destination's CLI is signed in and can reach where pages go.
   * The credential check runs with its stdout discarded — for gcloud it is a
   * live access token.
   */
  async check(destination: ShareDestination): Promise<ShareCheckResult> {
    const profile = authProfileOf(destination);
    const signIn = labelOf(profile);
    if (profile === null) {
      return { state: 'not-set-up', signIn };
    }
    if (profile.check !== null) {
      const result = await this.runCheck(profile.check);
      if (result.code !== 0) {
        return {
          state: checkStateOf(profile, result),
          detail: failureOf(result),
          signIn,
        };
      }
    }
    const listing = probeArgv(destination);
    if (listing === null) {
      return profile.check === null
        ? {
            state: 'check-failed',
            detail:
              'This command has no sign-in check — share a page to try it.',
            signIn,
          }
        : { state: 'signed-in', signIn };
    }
    const result = await this.run({
      ...listing,
      label: 'share:check',
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (
      result.code === 0 ||
      (destination.kind === 'gcs' && PROBE_EMPTY.test(result.stderr))
    ) {
      return {
        state: 'signed-in',
        detail: `Reached ${destination.name}.`,
        signIn,
      };
    }
    return {
      state: checkStateOf(profile, result),
      detail: failureOf(result),
      signIn,
    };
  }

  /**
   * Try every share waiting on this destination's sign-in once more, at the
   * page's newest version — after the user signed in. Each one ends `live`,
   * stays `awaiting-sign-in` (still signed out) or ends `failed`, and its
   * asker, if any, is woken with how it ended. An agent's share is dropped
   * instead while agents may not share. Returns the ids tried.
   */
  async retryAwaiting(destinationId: string): Promise<string[]> {
    const waiting = (await this.dao.listByStatus('awaiting-sign-in')).filter(
      (row) => this.destinationIdOf(row) === destinationId,
    );
    const retried: string[] = [];
    for (const row of waiting) {
      await this.locked(`${row.runId}/${row.artifactId}`, async () => {
        const fresh = await this.dao.getById(row.id);
        if (fresh === null || fresh.status !== 'awaiting-sign-in') {
          return;
        }
        // The switch alone: the row already names the place it goes to, so a
        // default place removed since is no reason to drop it unannounced.
        if (fresh.asker !== null && this.config?.agentsMayShare === false) {
          await this.dropRow(fresh);
          return;
        }
        retried.push(fresh.id);
        try {
          await this.shareUnlocked({
            runId: fresh.runId,
            artifactId: fresh.artifactId,
            title: fresh.title,
            by: fresh.sharedBy,
          });
        } catch (error) {
          // An upload failure has already settled the row; what stopped the
          // share before any upload (the page gone, the key gone) has not.
          const after = await this.dao.getById(fresh.id);
          if (after?.status === 'awaiting-sign-in') {
            await this.settleFailed(
              after,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      });
    }
    return retried;
  }

  /**
   * Wake again every asker a share still owes its outcome — the boot sweep,
   * run once the daemon listens: a wake lost to a restart is sent once more.
   */
  async republishOwedWakes(): Promise<void> {
    // Whether agents may share is unknown until Electron main pushes the
    // settings: the sweep waits for that push rather than guess.
    if (this.config === null) {
      this.sweepOnConfig = true;
      return;
    }
    for (const row of await this.dao.listOwedWakes()) {
      await this.wakeAsker(row).catch((err: unknown) => {
        this.logger.warn(
          `could not wake the agent waiting on share ${row.id}: ${String(err)}`,
        );
      });
    }
  }

  private async shareUnlocked(
    input: ShareInput,
  ): Promise<{ share: Share; url: string | null }> {
    if (this.config === null) {
      throw new BadRequestException(
        'SHARE_NOT_CONFIGURED',
        'the sharing settings have not reached the daemon yet',
      );
    }
    if (input.themeVars !== undefined) {
      this.lastThemeVars = input.themeVars;
    }
    const latest = this.store.latest(input.runId, input.artifactId);
    const document =
      latest === null
        ? null
        : this.pages.document(
            input.runId,
            input.artifactId,
            latest.version,
            latest.key,
          );
    if (latest === null || document === null) {
      throw new NotFoundException('ARTIFACT_NOT_FOUND', PAGE_GONE);
    }
    const html = buildPortableArtifact(
      document,
      input.themeVars ?? this.lastThemeVars,
    );
    const existing = await this.dao.findByArtifact(
      input.runId,
      input.artifactId,
    );
    return existing === null
      ? this.firstShare(input, latest.version, html)
      : this.reshare(existing, input, latest.version, html);
  }

  private async firstShare(
    input: ShareInput,
    version: number,
    html: string,
  ): Promise<{ share: Share; url: string | null }> {
    const destination = this.pickDestination(input.destinationId);
    const id = randomUUID();
    const objectId = mintObjectId();
    const key = mintShareKey();
    // The key is saved BEFORE the upload: an uploaded page whose key was lost
    // could never be linked to again — and a share left waiting on sign-in
    // keeps it, so the link it will have is fixed from the first attempt.
    await this.keychain.write(id, key);
    const attempt = await this.attempt(destination, objectId, html, key);
    if (!attempt.ok && attempt.cause === 'other') {
      await this.keychain.delete(id).catch((cleanup: unknown) => {
        this.logger.warn(
          `could not remove an unused share key: ${String(cleanup)}`,
        );
      });
      throw uploadFailed(destination, attempt.detail);
    }
    const row = await this.dao.create({
      id,
      runId: input.runId,
      artifactId: input.artifactId,
      title: input.title,
      destination: JSON.stringify(destination),
      objectId,
      linkBase: destination.linkBase,
      sharedBy: input.by,
      ...(attempt.ok
        ? { sharedVersion: version }
        : {
            sharedVersion: 0,
            status: 'awaiting-sign-in' as const,
            lastError: attempt.detail,
            asker: askersColumn(input.asker === undefined ? [] : [input.asker]),
          }),
    });
    this.announce(row, null);
    return {
      share: this.toWire(row),
      url: attempt.ok ? linkFor(destination, objectId, key) : null,
    };
  }

  private async reshare(
    existing: ArtifactShare,
    input: ShareInput,
    version: number,
    html: string,
  ): Promise<{ share: Share; url: string | null }> {
    const key = await this.keychain.read(existing.id);
    if (key === null) {
      throw new NotFoundException('SHARE_KEY_MISSING', KEY_MISSING);
    }
    // Nothing was uploaded yet, so no link is fixed: the share goes where
    // Settings say now — the row's place while it is still there.
    const replaced = existing.sharedVersion === 0;
    const destination = replaced
      ? this.pickDestination(
          input.destinationId ??
            (this.isConfigured(this.destinationIdOf(existing))
              ? (this.destinationIdOf(existing) ?? undefined)
              : undefined),
        )
      : this.destinationOf(existing);
    const place = replaced
      ? {
          destination: JSON.stringify(destination),
          linkBase: destination.linkBase,
        }
      : {};
    const attempt = await this.attempt(
      destination,
      existing.objectId,
      html,
      key,
    );
    // Every agent that asked earlier is still waiting, except the one asking
    // now — its own receipt tells it.
    const earlier =
      existing.status === 'awaiting-sign-in' ? askersOf(existing.asker) : [];
    const asking = input.asker;
    const waiting =
      asking === undefined
        ? earlier
        : earlier.filter((other) => !sameAsker(other, asking));
    if (attempt.ok) {
      const row = await this.write(existing, {
        ...place,
        title: input.title,
        sharedVersion: version,
        sharedBy: input.by,
        status: 'live',
        lastError: null,
        asker: askersColumn(waiting),
        agentToldAt: null,
      });
      await this.wakeAsker(row);
      return {
        share: this.toWire(row),
        url: linkFor(destination, row.objectId, key),
      };
    }
    if (attempt.cause === 'auth') {
      const row = await this.write(existing, {
        ...place,
        title: input.title,
        status: 'awaiting-sign-in',
        lastError: attempt.detail,
        asker: askersColumn(
          asking === undefined ? waiting : [...waiting, asking],
        ),
        agentToldAt: null,
      });
      return { share: this.toWire(row), url: null };
    }
    if (
      existing.status === 'awaiting-sign-in' ||
      existing.sharedVersion === 0
    ) {
      await this.settleFailed(
        await this.write(existing, {
          ...place,
          asker: askersColumn(waiting),
          agentToldAt: null,
        }),
        attempt.detail,
      );
    }
    throw uploadFailed(destination, attempt.detail);
  }

  /**
   * A share that waited ends without an upload: `failed` when nothing was ever
   * uploaded, else back to `live` on the version the object still holds. Its
   * asker is told why.
   */
  private async settleFailed(
    row: ArtifactShare,
    reason: string,
  ): Promise<void> {
    const settled = await this.write(row, {
      status: row.sharedVersion === 0 ? 'failed' : 'live',
      lastError: row.sharedVersion === 0 ? reason : null,
    });
    await this.wakeAsker(settled, reason);
  }

  /** The credential check, then the upload; a signed-out CLI never uploads. */
  private async attempt(
    destination: ShareDestination,
    objectId: string,
    html: string,
    key: string,
  ): Promise<Attempt> {
    const profile = authProfileOf(destination);
    if (profile?.check) {
      const check = await this.runCheck(profile.check);
      if (check.code !== 0 && classifyShareFailure(profile, check) === 'auth') {
        return { ok: false, cause: 'auth', detail: failureOf(check) };
      }
    }
    const result = await this.upload(destination, objectId, html, key);
    return result.code === 0
      ? { ok: true }
      : {
          ok: false,
          cause: classifyShareFailure(profile, result),
          detail: failureOf(result),
        };
  }

  /** A profile's credential check. Its stdout can be a live token, so none of it is kept. */
  private runCheck(check: DestinationCommand): Promise<ManagedCommandResult> {
    return this.run({
      ...check,
      label: 'share:check',
      timeoutMs: PROBE_TIMEOUT_MS,
      discardStdout: true,
    });
  }

  private async upload(
    destination: ShareDestination,
    objectId: string,
    html: string,
    key: string,
  ): Promise<ManagedCommandResult> {
    const dir = await mkdtemp(join(tmpdir(), 'geniro-share-'));
    try {
      const file = join(dir, 'index.html');
      // Ciphertext only — the plaintext page never touches the disk here.
      await writeFile(file, buildShareEnvelope(html, key), { mode: 0o600 });
      return await this.run({
        ...destinationArgv(destination, 'upload', { objectId, file }),
        label: 'share:upload',
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Tell every agent waiting on a share how it ended, if any is and they have
   * not been told yet: the link when the share is `live` and no `failure` is
   * given, else why it was not shared. The link goes into the wakes' prompt
   * only, never their row — and only while agents may share: with the switch
   * off a link not yet sent is withdrawn, never handed over.
   */
  private async wakeAsker(row: ArtifactShare, failure?: string): Promise<void> {
    const askers = askersOf(row.asker);
    if (askers.length === 0 || row.agentToldAt !== null) {
      return;
    }
    if (row.status !== 'live' && row.status !== 'failed') {
      return;
    }
    const outcome = await this.outcomeOf(row, failure);
    if (outcome.link !== null && this.config?.agentsMayShare !== true) {
      await this.write(row, { asker: null, agentToldAt: null });
      return;
    }
    const text =
      outcome.link !== null
        ? `[geniro] The page "${row.title}" you asked to share is now shared — the user signed in. Shared link: ${outcome.link}\nPut this link wherever you were asked to put it.`
        : `[geniro] The page "${row.title}" you asked to share could not be shared after the user signed in. Not shared: ${outcome.reason}`;
    for (const asker of askers) {
      this.wakes.publish(
        this.wakeFor(row, asker, outcome, text, () => {
          void this.settleAsker(row, asker);
        }),
      );
    }
  }

  private wakeFor(
    row: ArtifactShare,
    asker: ShareAsker,
    outcome: { link: string; reason: null } | { link: null; reason: string },
    text: string,
    onDelivered: () => void,
  ): HostWake {
    return {
      key: `share:${row.id}:${asker.runId}:${asker.caller}`,
      owner: asker,
      prompt: text,
      note: text,
      row: {
        severity: 'info',
        message:
          outcome.link !== null
            ? `Shared "${row.title}" once you signed in — the agent was sent the link.`
            : `"${row.title}" was not shared: ${outcome.reason}`,
        shares: [
          {
            shareId: row.id,
            title: row.title,
            ...(outcome.link !== null
              ? { outcome: 'shared' as const }
              : { outcome: 'not-shared' as const, reason: outcome.reason }),
          },
        ],
        woke: true,
      },
      onDelivered,
      // A link is withdrawn, never sent, once the user stops letting agents
      // share — also from a wake already waiting for its turn.
      withdrawn: () =>
        outcome.link !== null && this.config?.agentsMayShare !== true,
    };
  }

  /** The link a settled share hands its asker, or why there is none. */
  private async outcomeOf(
    row: ArtifactShare,
    failure: string | undefined,
  ): Promise<{ link: string; reason: null } | { link: null; reason: string }> {
    if (failure !== undefined) {
      return { link: null, reason: failure };
    }
    if (row.status === 'failed') {
      return { link: null, reason: row.lastError ?? 'the upload failed' };
    }
    const key = await this.keychain.read(row.id);
    return key === null
      ? { link: null, reason: KEY_MISSING }
      : {
          link: linkFor(this.destinationOf(row), row.objectId, key),
          reason: null,
        };
  }

  /**
   * One asker's wake settled: it leaves the row, so a boot never wakes it
   * again; the share counts as told once none is left.
   */
  private async settleAsker(
    row: ArtifactShare,
    asker: ShareAsker,
  ): Promise<void> {
    await this.locked(`${row.runId}/${row.artifactId}`, async () => {
      const fresh = await this.dao.getById(row.id);
      if (fresh === null) {
        return;
      }
      const left = askersOf(fresh.asker).filter(
        (other) => !sameAsker(other, asker),
      );
      await this.write(fresh, {
        asker: askersColumn(left),
        ...(left.length === 0 && fresh.agentToldAt === null
          ? { agentToldAt: new Date() }
          : {}),
      });
    });
  }

  /**
   * Drop what waits on sign-in for a run gone or archived, or for agents no
   * longer allowed to share: a share never uploaded goes with its key; one
   * that holds an older upload goes back to `live` on it.
   */
  private async dropPending(
    scope: { runId: string } | { askedByAgent: true },
    why: 'deleted' | 'archived' | 'agents-off',
  ): Promise<void> {
    try {
      const rows =
        'runId' in scope
          ? await this.dao.list(scope.runId)
          : await this.dao.listByStatus('awaiting-sign-in');
      for (const row of rows) {
        const pending =
          row.status === 'awaiting-sign-in' ||
          (row.sharedVersion === 0 && why !== 'agents-off');
        if (!pending || ('askedByAgent' in scope && row.asker === null)) {
          continue;
        }
        await this.locked(`${row.runId}/${row.artifactId}`, async () => {
          const fresh = await this.dao.getById(row.id);
          if (fresh !== null) {
            await this.dropRow(fresh);
          }
        });
      }
    } catch (err) {
      this.logger.warn(
        `could not drop shares waiting on sign-in (${why}): ${String(err)}`,
      );
    }
  }

  /** Under the row's lock: gone with its key if never uploaded, else back to `live`. */
  private async dropRow(row: ArtifactShare): Promise<void> {
    if (row.sharedVersion === 0) {
      await this.removeRow(row);
    } else if (row.status === 'awaiting-sign-in') {
      await this.write(row, {
        status: 'live',
        lastError: null,
        asker: null,
        agentToldAt: null,
      });
    }
  }

  /**
   * A waiting share whose place was removed from Settings can never be signed
   * in for again, so it ends `failed` and its asker is told why — instead of
   * waiting for a sign-in nothing can start.
   */
  private async settleOrphans(config: ShareConfig): Promise<void> {
    try {
      const present = new Set(config.destinations.map((d) => d.id));
      for (const row of await this.dao.listByStatus('awaiting-sign-in')) {
        const destinationId = this.destinationIdOf(row);
        if (destinationId !== null && present.has(destinationId)) {
          continue;
        }
        await this.locked(`${row.runId}/${row.artifactId}`, async () => {
          const fresh = await this.dao.getById(row.id);
          if (fresh?.status === 'awaiting-sign-in') {
            await this.settleFailed(fresh, PLACE_REMOVED);
          }
        });
      }
    } catch (err) {
      this.logger.warn(
        `could not settle shares whose place was removed: ${String(err)}`,
      );
    }
  }

  private async removeRow(row: ArtifactShare): Promise<void> {
    await this.keychain.delete(row.id);
    await this.dao.remove(row.id);
    this.events.publish({
      runId: row.runId,
      shareId: row.id,
      status: 'removed',
      title: row.title,
      destinationName: this.toWire(row).destinationName,
      askedByAgent: false,
      signInRequested: false,
    });
  }

  /** Update a row, then announce it. */
  private async write(
    row: ArtifactShare,
    patch: Partial<
      Pick<
        ArtifactShare,
        | 'title'
        | 'destination'
        | 'linkBase'
        | 'sharedVersion'
        | 'sharedBy'
        | 'status'
        | 'lastError'
        | 'asker'
        | 'agentToldAt'
      >
    >,
  ): Promise<ArtifactShare> {
    const before = row.status;
    const updated = await this.dao.updateAndReturn(row.id, patch);
    this.announce(updated, before);
    return updated;
  }

  private announce(row: ArtifactShare, before: ShareStatus | null): void {
    const wire = this.toWire(row);
    this.events.publish({
      runId: row.runId,
      shareId: row.id,
      status: row.status,
      title: row.title,
      destinationName: wire.destinationName,
      askedByAgent: wire.askedByAgent,
      signInRequested:
        wire.askedByAgent &&
        row.status === 'awaiting-sign-in' &&
        before !== 'awaiting-sign-in',
    });
  }

  private pickDestination(destinationId: string | undefined): ShareDestination {
    const config = this.config;
    const id = destinationId ?? config?.defaultDestinationId ?? null;
    const destination =
      id === null
        ? undefined
        : config?.destinations.find((candidate) => candidate.id === id);
    if (destination === undefined) {
      throw new BadRequestException(
        'SHARE_NO_DESTINATION',
        id === null
          ? NO_DEFAULT_DESTINATION
          : 'that place to share to is not in Settings → Sharing',
      );
    }
    return destination;
  }

  private agentRefusal(viaRemote: boolean): string | null {
    if (viaRemote) {
      return 'sharing is only available on the Mac, not from a paired device';
    }
    if (this.config === null) {
      return 'the sharing settings have not reached the daemon yet';
    }
    if (!this.config.agentsMayShare) {
      return 'the user has not allowed agents to share pages (Settings → Sharing)';
    }
    const id = this.config.defaultDestinationId;
    if (id === null || !this.config.destinations.some((d) => d.id === id)) {
      return NO_DEFAULT_DESTINATION;
    }
    return null;
  }

  /** The destination snapshot a row was shared to — where its object really is. */
  private destinationOf(row: ArtifactShare): ShareDestination {
    let raw: unknown;
    try {
      raw = JSON.parse(row.destination);
    } catch {
      raw = null;
    }
    const parsed = ShareDestinationSchema.safeParse(raw);
    if (!parsed.success) {
      throw new InternalException(
        'SHARE_DESTINATION_UNREADABLE',
        'the destination this page was shared to could not be read',
      );
    }
    return parsed.data;
  }

  private isConfigured(destinationId: string | null): boolean {
    return (
      destinationId !== null &&
      (this.config?.destinations.some((d) => d.id === destinationId) ?? false)
    );
  }

  private destinationIdOf(row: ArtifactShare): string | null {
    try {
      return this.destinationOf(row).id;
    } catch {
      return null;
    }
  }

  private toWire(row: ArtifactShare): Share {
    let destinationId = '';
    let destinationName = '';
    let signIn: ShareSignInLabel | null = null;
    try {
      const destination = this.destinationOf(row);
      destinationId = destination.id;
      destinationName = destination.name;
      signIn = labelOf(authProfileOf(destination));
    } catch {
      // Listed anyway, so the user still sees the link exists: a revoke cannot
      // reach a destination it cannot read, so its object is removed by hand.
    }
    return {
      id: row.id,
      runId: row.runId,
      artifactId: row.artifactId,
      title: row.title,
      destinationId,
      destinationName,
      sharedVersion: row.sharedVersion,
      sharedBy: row.sharedBy,
      status: row.status,
      lastError: row.lastError,
      signIn,
      askedByAgent: askersOf(row.asker).length > 0 && row.agentToldAt === null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    this.locks.set(key, settled);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === settled) {
        this.locks.delete(key);
      }
    }
  }
}

function checkStateOf(
  profile: ShareAuthProfile,
  result: ManagedCommandResult,
): 'sign-in-required' | 'check-failed' {
  return classifyShareFailure(profile, result) === 'auth'
    ? 'sign-in-required'
    : 'check-failed';
}

function labelOf(profile: ShareAuthProfile | null): ShareSignInLabel | null {
  return profile === null ? null : { cli: profile.cli, label: profile.label };
}

/** The column for these askers: null when nobody waits. */
function askersColumn(askers: readonly ShareAsker[]): string | null {
  return askers.length === 0 ? null : JSON.stringify(askers);
}

function sameAsker(a: ShareAsker, b: ShareAsker): boolean {
  return a.runId === b.runId && a.caller === b.caller;
}

/** Every agent conversation waiting on a share; an unreadable entry waits for nothing. */
function askersOf(column: string | null): ShareAsker[] {
  if (column === null) {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(column);
  } catch {
    return [];
  }
  return (Array.isArray(raw) ? raw : []).flatMap((entry: unknown) => {
    const value = entry as Partial<ShareAsker> | null;
    return typeof value?.runId === 'string' &&
      typeof value.nodeId === 'string' &&
      typeof value.caller === 'string' &&
      (value.conversationId === null ||
        typeof value.conversationId === 'string') &&
      (value.target === 'chat' || value.target === 'workflow')
      ? [
          {
            runId: value.runId,
            nodeId: value.nodeId,
            caller: value.caller,
            conversationId: value.conversationId,
            target: value.target,
          },
        ]
      : [];
  });
}

/** A 4xx on purpose: the exception filter replaces every 5xx message, and the reason is what the user needs. */
function uploadFailed(
  destination: ShareDestination,
  detail: string,
): BadRequestException {
  return new BadRequestException(
    'SHARE_UPLOAD_FAILED',
    `the upload to ${destination.name} failed: ${detail}`,
  );
}

/** One line saying why a destination command failed, for the user. */
function failureOf(result: ManagedCommandResult): string {
  if (result.spawnError !== undefined) {
    return `the command could not be started (${result.spawnError}) — is its CLI installed?`;
  }
  if (result.timedOut) {
    return 'the command timed out';
  }
  const line = result.stderr
    .split('\n')
    .map((text) => text.trim())
    .find((text) => text.length > 0);
  return line ?? `the command exited with status ${String(result.code)}`;
}

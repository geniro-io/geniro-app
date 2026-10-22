import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import {
  BadRequestException,
  InternalException,
  NotFoundException,
} from '@packages/common';

import { ArtifactPageService } from '../../agents/services/artifact-page.service';
import { ArtifactStoreService } from '../../agents/services/artifact-store.service';
import type { ManagedCommandResult } from '../../agents/utils/managed-command';
import { ArtifactShareDao } from '../dao/artifact-share.dao';
import type { ArtifactShare } from '../entity/artifact-share.entity';
import {
  type AgentShareOutcome,
  type RevokeManyOutcome,
  type RevokeOutcome,
  type Share,
  SHARE_COMMAND_RUNNER,
  type ShareActor,
  type ShareCommandRunner,
  type ShareConfig,
  type ShareDestination,
  ShareDestinationSchema,
  type ShareThemeVars,
} from '../shares.types';
import { buildPortableArtifact } from '../utils/portable-artifact';
import {
  destinationArgv,
  linkFor,
  mintObjectId,
  PROBE_EMPTY,
  probeArgv,
  removeFoundNothing,
} from '../utils/share-destinations';
import { buildShareEnvelope, mintShareKey } from '../utils/share-envelope';
import { ShareKeychain } from './share-keychain.service';

const UPLOAD_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_REVOKE_FIRST_CHECK_MS = 60 * 1000;
const AUTO_REVOKE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const KEY_MISSING =
  'the key for this link is no longer in the Keychain — revoke it and share the page again';
const NO_DEFAULT_DESTINATION =
  'no default place to share to is set in Settings → Sharing';

interface ShareInput {
  runId: string;
  artifactId: string;
  title: string;
  by: ShareActor;
  destinationId?: string;
  themeVars?: ShareThemeVars;
}

/**
 * Shares artifacts as end-to-end-encrypted links on a destination the user
 * configured — the daemon side of Settings → Sharing and of
 * `show_artifact(share: true)`.
 *
 * The page is encrypted here, on the Mac, and only the envelope is uploaded,
 * through the user's own CLI and login; the key lives in the Keychain and in
 * the link's fragment. geniro runs no server and holds no credential.
 *
 * The configuration is pushed by Electron main (which owns settings.json) on
 * every daemon start and after every settings write, and is held in memory
 * only. Until the first push nothing can be shared, by anyone.
 */
@Injectable()
export class ShareService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ShareService.name);
  private config: ShareConfig | null = null;
  private configReceivedAt: Date | null = null;
  private autoRevokeFirst: ReturnType<typeof setTimeout> | null = null;
  private autoRevokeTimer: ReturnType<typeof setInterval> | null = null;
  private autoRevoking: Promise<RevokeManyOutcome> | null = null;
  /**
   * The theme of the last press, reused for an agent's share: the daemon has
   * no window to read a theme from, and the last one the user looked at is the
   * best stand-in. Null until a press; the page then takes its light defaults.
   */
  private lastThemeVars: ShareThemeVars | null = null;
  /** One operation per share at a time, keyed by `<runId>/<artifactId>`. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dao: ArtifactShareDao,
    private readonly store: ArtifactStoreService,
    private readonly pages: ArtifactPageService,
    private readonly keychain: ShareKeychain,
    @Inject(SHARE_COMMAND_RUNNER) private readonly run: ShareCommandRunner,
  ) {}

  // Once a minute after the start, so an app never left open for a whole
  // interval still sweeps, then on the interval. Never on a settings push:
  // picking a shorter window revokes nothing in the same gesture.
  onModuleInit(): void {
    this.autoRevokeFirst = setTimeout(() => {
      void this.revokeExpired();
    }, AUTO_REVOKE_FIRST_CHECK_MS);
    this.autoRevokeFirst.unref?.();
    this.autoRevokeTimer = setInterval(() => {
      void this.revokeExpired();
    }, AUTO_REVOKE_CHECK_EVERY_MS);
    this.autoRevokeTimer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.autoRevokeFirst !== null) {
      clearTimeout(this.autoRevokeFirst);
      this.autoRevokeFirst = null;
    }
    if (this.autoRevokeTimer !== null) {
      clearInterval(this.autoRevokeTimer);
      this.autoRevokeTimer = null;
    }
  }

  setConfig(config: ShareConfig): { receivedAt: string } {
    this.config = config;
    this.configReceivedAt = new Date();
    return { receivedAt: this.configReceivedAt.toISOString() };
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
   */
  share(input: ShareInput): Promise<{ share: Share; url: string }> {
    return this.locked(`${input.runId}/${input.artifactId}`, () =>
      this.shareUnlocked(input),
    );
  }

  /**
   * An agent's `show_artifact(share: true)`. Never throws: whatever stops the
   * share becomes a reason the agent is told, and the publish it rode on
   * stands either way.
   */
  async shareForAgent(
    input: Omit<ShareInput, 'by' | 'destinationId' | 'themeVars'>,
    viaRemote: boolean,
  ): Promise<AgentShareOutcome> {
    const refusal = this.agentRefusal(viaRemote);
    if (refusal !== null) {
      return { kind: 'not-shared', reason: refusal };
    }
    try {
      const { url } = await this.share({ ...input, by: 'agent' });
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
      const destination = this.destinationOf(row);
      const result = await this.run({
        ...destinationArgv(destination, 'remove', { objectId: row.objectId }),
        label: 'share:revoke',
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
      if (result.code !== 0 && !removeFoundNothing(destination, result)) {
        const detail = failureOf(result);
        await this.dao.updateById(row.id, {
          status: 'revoke-failed',
          lastError: detail,
        });
        return { status: 'revoke-failed', detail };
      }
      // Remote first, then the key: a key deleted while the object survived
      // would leave a live link nobody could ever revoke from here.
      await this.keychain.delete(row.id);
      await this.dao.remove(row.id);
      return { status: 'revoked' };
    });
  }

  /** Revoke these pages, carrying on past a failure; one already gone counts as neither. */
  revokeAll(shareIds: string[]): Promise<RevokeManyOutcome> {
    return this.revokeEach(shareIds, () => true);
  }

  /**
   * Revoke the pages shared longer ago than the user's `autoRevokeAfterDays`;
   * nothing when it is null. Never rejects, and one sweep runs at a time: a
   * call while one runs joins it, and its `now` is not used.
   */
  revokeExpired(now: number = Date.now()): Promise<RevokeManyOutcome> {
    this.autoRevoking ??= this.sweepExpired(now).finally(() => {
      this.autoRevoking = null;
    });
    return this.autoRevoking;
  }

  private async sweepExpired(now: number): Promise<RevokeManyOutcome> {
    const cutoff = this.autoRevokeCutoff(now);
    if (cutoff === null) {
      return { revoked: 0, failed: 0, detail: null };
    }
    try {
      // Asked again per page: each revoke waits on the user's CLI, and the
      // setting may be lengthened or switched off while the sweep runs.
      const sharedAt = new Map(
        (await this.dao.sharedBefore(cutoff)).map((row) => [
          row.id,
          row.createdAt,
        ]),
      );
      const outcome = await this.revokeEach([...sharedAt.keys()], (id) => {
        const current = this.autoRevokeCutoff(now);
        const at = sharedAt.get(id);
        return current !== null && at !== undefined && at < current;
      });
      if (outcome.revoked > 0) {
        this.logger.log(`revoked ${outcome.revoked} expired shared page(s)`);
      }
      if (outcome.failed > 0) {
        this.logger.warn(
          `could not revoke ${outcome.failed} expired shared page(s): ${outcome.detail ?? ''}`,
        );
      }
      return outcome;
    } catch (error) {
      this.logger.warn(
        `could not sweep expired shared pages: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { revoked: 0, failed: 0, detail: null };
    }
  }

  private autoRevokeCutoff(now: number): Date | null {
    const days = this.config?.autoRevokeAfterDays ?? null;
    return days === null ? null : new Date(now - days * DAY_MS);
  }

  private async revokeEach(
    shareIds: string[],
    stillWanted: (id: string) => boolean,
  ): Promise<RevokeManyOutcome> {
    let revoked = 0;
    let failed = 0;
    let detail: string | null = null;
    for (const id of new Set(shareIds)) {
      if (!stillWanted(id)) {
        continue;
      }
      try {
        const outcome = await this.revoke(id);
        if (outcome.status === 'revoked') {
          revoked += 1;
        } else {
          failed += 1;
          detail ??= outcome.detail;
        }
      } catch (error) {
        // Already revoked, by another press or before this list was read.
        if (error instanceof NotFoundException) {
          continue;
        }
        failed += 1;
        detail ??= error instanceof Error ? error.message : String(error);
      }
    }
    return { revoked, failed, detail };
  }

  async probe(
    destination: ShareDestination,
  ): Promise<{ ok: boolean; detail: string }> {
    const command = probeArgv(destination);
    if (command === null) {
      return {
        ok: false,
        detail:
          'A custom command has nothing to test — share a page to try it.',
      };
    }
    const result = await this.run({
      ...command,
      label: 'share:probe',
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return result.code === 0 ||
      (destination.kind === 'gcs' && PROBE_EMPTY.test(result.stderr))
      ? { ok: true, detail: `Reached ${destination.name}.` }
      : { ok: false, detail: failureOf(result) };
  }

  private async shareUnlocked(
    input: ShareInput,
  ): Promise<{ share: Share; url: string }> {
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
      throw new NotFoundException(
        'ARTIFACT_NOT_FOUND',
        'this page is no longer stored, so it cannot be shared',
      );
    }
    const html = buildPortableArtifact(
      document,
      input.themeVars ?? this.lastThemeVars,
    );

    const existing = await this.dao.findByArtifact(
      input.runId,
      input.artifactId,
    );
    if (existing !== null) {
      const key = await this.keychain.read(existing.id);
      if (key === null) {
        throw new NotFoundException('SHARE_KEY_MISSING', KEY_MISSING);
      }
      const destination = this.destinationOf(existing);
      await this.upload(destination, existing.objectId, html, key);
      const row = await this.dao.updateAndReturn(existing.id, {
        title: input.title,
        sharedVersion: latest.version,
        sharedBy: input.by,
        status: 'live',
        lastError: null,
      });
      return {
        share: this.toWire(row),
        url: linkFor(destination, row.objectId, key),
      };
    }

    const destination = this.pickDestination(input.destinationId);
    const id = randomUUID();
    const objectId = mintObjectId();
    const key = mintShareKey();
    // The key is saved BEFORE the upload: an uploaded page whose key was lost
    // could never be linked to again.
    await this.keychain.write(id, key);
    try {
      await this.upload(destination, objectId, html, key);
    } catch (error) {
      await this.keychain.delete(id).catch((cleanup: unknown) => {
        this.logger.warn(
          `could not remove an unused share key: ${String(cleanup)}`,
        );
      });
      throw error;
    }
    const row = await this.dao.create({
      id,
      runId: input.runId,
      artifactId: input.artifactId,
      title: input.title,
      destination: JSON.stringify(destination),
      objectId,
      linkBase: destination.linkBase,
      sharedVersion: latest.version,
      sharedBy: input.by,
    });
    return {
      share: this.toWire(row),
      url: linkFor(destination, objectId, key),
    };
  }

  private async upload(
    destination: ShareDestination,
    objectId: string,
    html: string,
    key: string,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'geniro-share-'));
    try {
      const file = join(dir, 'index.html');
      // Ciphertext only — the plaintext page never touches the disk here.
      await writeFile(file, buildShareEnvelope(html, key), { mode: 0o600 });
      const result = await this.run({
        ...destinationArgv(destination, 'upload', { objectId, file }),
        label: 'share:upload',
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
      if (result.code !== 0) {
        // A 4xx on purpose: the exception filter replaces every 5xx message,
        // and the reason is what the user needs to fix their CLI or bucket.
        throw new BadRequestException(
          'SHARE_UPLOAD_FAILED',
          `the upload to ${destination.name} failed: ${failureOf(result)}`,
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  private toWire(row: ArtifactShare): Share {
    let destinationId = '';
    let destinationName = '';
    try {
      const destination = this.destinationOf(row);
      destinationId = destination.id;
      destinationName = destination.name;
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

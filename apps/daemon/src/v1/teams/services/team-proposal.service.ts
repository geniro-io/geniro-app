import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import { BaseException, ConflictException } from '@packages/common';

import {
  type DeferredCardResponder,
  HOST_PROPOSE_TEAM_TOOL,
  type TeamProposalOutcome,
  type TeamProposalVerdict,
} from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { ChatService } from '../../agents/services/chat.service';
import {
  standingProposalCardId,
  teamVerdictMessage,
} from '../../agents/utils/host-teams';
import {
  type PendingTeamProposal,
  PendingTeamProposalSchema,
  type ProposalOutcome,
  type Team,
  type TeamChangeProposalRequest,
  type TeamProposal,
  type TeamProposalRequest,
} from '../teams.types';
import {
  firstLineOf,
  redactConfigDirText,
  restoreConfigDirs,
} from '../utils/config-dir-redaction';
import { editTeam, TEAM_FILE_EDIT_COPY } from '../utils/edit-team';
import { fromLegacyPendingProposal } from '../utils/legacy-proposal';
import { backUpTeam, readTeamSource } from '../utils/team-backup';
import { checkTeam } from '../utils/team-check';
import { diffTeams } from '../utils/team-diff';
import { parseTeamYaml } from '../utils/team-yaml';
import { agentsThatRunAuto } from '../utils/unattended';
import { GraphExecutorService } from './graph-executor.service';
import { TeamChangeLogService } from './team-change-log.service';
import { TeamStoreService } from './team-store.service';

export type PreparedProposal =
  | { ok: true; proposal: TeamProposal }
  | { ok: false; code: string; message: string };

export type AppliedProposal =
  | { outcome: 'saved'; slug: string; backup: string | null }
  /** A replacement whose file changed since the card was raised. */
  | { outcome: 'changed' }
  /** A new team whose slug was taken since the card was raised. */
  | { outcome: 'exists' }
  /** A replacement whose file was deleted since the card was raised. */
  | { outcome: 'gone' };

/**
 * The one path an agent's whole-team proposal reaches the library by.
 *
 * `prepare` decides everything the card shows — whether the team could run
 * at all, the file it would write, and against which version — so the user
 * approves exactly what will be written. `apply` writes it only if that is
 * still true, backing a replaced file up first.
 *
 * The card is a deferred one (`ChatService.raiseOwnedCard`): the agent is
 * answered at once and told to stop, the card waits on the user with no
 * deadline, and the verdict reaches the agent as the run's next message. One
 * card stands per run, in `Run.pendingTeamProposal`; only a newer proposal
 * or an archive retires it (a typed message does not), and it is put back at
 * boot.
 *
 * In `v1/teams` because the store and the run-start checks are; `v1/agents`
 * may not import it.
 */
@Injectable()
export class TeamProposalService {
  private readonly logger = new Logger(TeamProposalService.name);

  /** The proposal being raised per run, so two in one tick never both stand. */
  private readonly raising = new Map<string, Promise<unknown>>();

  /** Cards the user has pressed whose answer is still being carried out. */
  private readonly answering = new Set<string>();

  constructor(
    private readonly store: TeamStoreService,
    private readonly executor: GraphExecutorService,
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly chats: ChatService,
    private readonly changeLog: TeamChangeLogService,
  ) {}

  /**
   * Check a proposal and, if it holds, put its card up in place of the run's
   * standing one. Raised one at a time per run: the standing card is read
   * before the new one is written, so two racing proposals would otherwise
   * both find nothing standing and both stay on screen.
   */
  propose(
    runId: string,
    request: TeamProposalRequest,
  ): Promise<ProposalOutcome> {
    return this.raiseSerialized(runId, () => this.prepare(request));
  }

  /**
   * A team builder chat's change to its own team, on the same card:
   * the edits are carried out on the file as it stands now, and the card
   * shows what that does to it and writes exactly that on Approve.
   */
  proposeChange(
    runId: string,
    request: TeamChangeProposalRequest,
  ): Promise<ProposalOutcome> {
    return this.raiseSerialized(runId, () => this.prepareChange(request));
  }

  private async raiseSerialized(
    runId: string,
    prepare: () => Promise<PreparedProposal>,
  ): Promise<ProposalOutcome> {
    const previous = this.raising.get(runId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.proposeNow(runId, prepare));
    this.raising.set(runId, next);
    try {
      return await next;
    } finally {
      if (this.raising.get(runId) === next) {
        this.raising.delete(runId);
      }
    }
  }

  private async proposeNow(
    runId: string,
    prepare: () => Promise<PreparedProposal>,
  ): Promise<ProposalOutcome> {
    const prepared = await prepare();
    if (!prepared.ok) {
      return {
        status: 'refused',
        code: prepared.code,
        message: prepared.message,
      };
    }
    const { proposal } = prepared;
    const em = this.em.fork();
    const requestId = randomUUID();
    const done: RaiseProgress = {
      standing: null,
      retire: 'none',
      raised: false,
    };
    try {
      done.standing = readPending(
        (await this.runDao.getById(runId, em))?.pendingTeamProposal ?? null,
      );
      // A card the user has just pressed is being answered, not superseded:
      // writing it off now would close it twice.
      if (
        done.standing !== null &&
        !this.answering.has(done.standing.requestId)
      ) {
        done.retire = 'started';
        await this.chats.retireOwnedCard(
          runId,
          done.standing.requestId,
          HOST_PROPOSE_TEAM_TOOL,
        );
        done.retire = 'done';
      }
      await this.chats.raiseOwnedCard(
        runId,
        requestId,
        { toolName: HOST_PROPOSE_TEAM_TOOL, input: proposal },
        this.responderFor(runId, requestId, proposal),
      );
      done.raised = true;
      // AFTER the row: the column points at it, and a pointer written first
      // would survive a failed write as a card nothing ever drew.
      await this.runDao.setPendingTeamProposal(
        runId,
        JSON.stringify({
          requestId,
          proposal,
        } satisfies PendingTeamProposal),
        em,
      );
      // Again AFTER the column: an archive that began after the raise's own
      // check read the column before this write, and would leave the card
      // standing on an archived chat.
      if (await this.chats.isArchived(runId)) {
        throw new Error('the chat was archived while the card was raised');
      }
    } catch (error) {
      // Logged and replaced: a persist failure names a database path, and this
      // reason goes to a model whose provider is off this machine.
      this.logger.error(
        `run ${runId} could not put a team proposal on screen: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.undoRaise(runId, requestId, done);
      return {
        status: 'refused',
        code: 'CARD_NOT_SHOWN',
        message: 'the proposal card could not be written',
      };
    }
    return { status: 'shown', proposal };
  }

  /**
   * Leave the card, the registry and the column agreeing after a proposal that
   * failed half-way: a card raised but not recorded is taken down again; an
   * old card whose retire failed before its row was written is tracked again,
   * since it is still live on screen; and a column naming a card already
   * retired is cleared, or it would come back at boot as a live one.
   */
  private async undoRaise(
    runId: string,
    requestId: string,
    done: RaiseProgress,
  ): Promise<void> {
    try {
      if (done.raised) {
        await this.chats.retireOwnedCard(
          runId,
          requestId,
          HOST_PROPOSE_TEAM_TOOL,
        );
      }
      if (done.retire === 'started' && done.standing !== null) {
        this.chats.trackOwnedCard(
          runId,
          done.standing.requestId,
          {
            toolName: HOST_PROPOSE_TEAM_TOOL,
            input: done.standing.proposal,
          },
          this.responderFor(
            runId,
            done.standing.requestId,
            done.standing.proposal,
          ),
        );
      } else if (done.retire === 'done' || done.raised) {
        await this.runDao.setPendingTeamProposal(runId, null, this.em.fork());
      }
    } catch (error) {
      this.logger.error(
        `run ${runId} could not undo a team proposal: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Put every standing proposal card back in the registry at boot — the card
   * waits on a person, and the daemon's idle exit routinely comes first.
   *
   * Only a card still open in the transcript: one already answered or written
   * off (a crash between a retire and the next column write) loses its column
   * instead. A column whose proposal no longer reads closes its card, which
   * would otherwise stand on screen with nothing able to answer it. One run's
   * failure never stops the rest.
   */
  async rehydrate(): Promise<void> {
    let runs: Awaited<ReturnType<RunDao['listRunsWithPendingTeamProposal']>>;
    try {
      runs = await this.runDao.listRunsWithPendingTeamProposal(this.em.fork());
    } catch (error) {
      this.logger.error(
        `team proposal rehydration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    let restored = 0;
    for (const run of runs) {
      try {
        if (await this.rehydrateRun(run.id, run.pendingTeamProposal)) {
          restored += 1;
        }
      } catch (error) {
        this.logger.error(
          `run ${run.id} team proposal rehydration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (restored > 0) {
      this.logger.log(`restored ${restored} team proposal card(s)`);
    }
  }

  /** {@link rehydrate} for one run; true when its card was tracked again. */
  private async rehydrateRun(
    runId: string,
    column: string | null,
  ): Promise<boolean> {
    const em = this.em.fork();
    const cardId = standingProposalCardId(column);
    const closed =
      cardId !== null &&
      (
        await this.itemDao.rowsByPayloadId(
          runId,
          ['approval_verdict', 'unanswerable'],
          [cardId],
          undefined,
          em,
        )
      ).length > 0;
    const pending = readPending(column);
    if (cardId !== null && !closed && pending === null) {
      await this.chats.retireOwnedCard(runId, cardId, HOST_PROPOSE_TEAM_TOOL);
    }
    if (pending === null || closed) {
      await this.runDao.setPendingTeamProposal(runId, null, em);
      return false;
    }
    this.chats.trackOwnedCard(
      runId,
      pending.requestId,
      { toolName: HOST_PROPOSE_TEAM_TOOL, input: pending.proposal },
      this.responderFor(runId, pending.requestId, pending.proposal),
    );
    return true;
  }

  private responderFor(
    runId: string,
    requestId: string,
    proposal: TeamProposal,
  ): DeferredCardResponder {
    return (allow, answer) => {
      // Synchronously, before the answer's first await: a proposal raised
      // meanwhile must not retire the card being answered.
      this.answering.add(requestId);
      void this.carryOutVerdict(
        runId,
        requestId,
        proposal,
        allow,
        answer,
      ).finally(() => this.answering.delete(requestId));
    };
  }

  /**
   * The user pressed the card. ORDER is load-bearing: the column is cleared
   * BEFORE the file is written, so a crash between the two reads at the next
   * boot as a card that expired, never as a second write; and the verdict row
   * is written before the message, which starts the agent's next turn.
   */
  private async carryOutVerdict(
    runId: string,
    requestId: string,
    proposal: TeamProposal,
    allow: boolean,
    answer: string | undefined,
  ): Promise<void> {
    const note = answer ?? null;
    let verdict: TeamProposalVerdict = { kind: 'declined', note };
    let cleared = true;
    try {
      await this.runDao.setPendingTeamProposal(runId, null, this.em.fork());
    } catch (error) {
      cleared = false;
      this.logger.error(
        `run ${runId} could not close a team proposal card: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (allow && !cleared) {
      // A card still standing in the column comes back at the next boot, so a
      // write now could be followed by a second one.
      verdict = {
        kind: 'not-saved',
        cause: 'not-closed',
        reason: 'the card could not be closed, so nothing was written',
        note,
      };
    } else if (allow) {
      try {
        verdict = verdictOf(
          proposal,
          await this.apply(proposal, { runId, note }),
          note,
        );
      } catch (error) {
        this.logger.error(
          `run ${runId} could not save an approved team: ${error instanceof Error ? error.message : String(error)}`,
        );
        verdict = {
          kind: 'not-saved',
          cause: 'write-failed',
          reason: 'the file could not be written',
          note,
        };
      }
    }
    await this.chats.deliverOwnedCardVerdict(
      runId,
      requestId,
      allow,
      teamVerdictMessage(verdict),
      answer,
      outcomeOf(verdict),
    );
  }

  async prepare(request: TeamProposalRequest): Promise<PreparedProposal> {
    const checked = checkTeam(request.team);
    if (!checked.ok) {
      return { ok: false, code: checked.code, message: checked.message };
    }
    // The team it replaces first: a `configDir` the agent read as a token
    // is put back before the team is checked as runnable, diffed or shown
    // (the schema check above takes a token as it takes any path).
    let current: Awaited<ReturnType<TeamStoreService['get']>> | null = null;
    if (request.replaces !== undefined) {
      try {
        current = await this.store.get(request.replaces);
      } catch (error) {
        // A YAML parse error quotes the file's lines around the fault, a
        // profile path among them: the agent gets its first line only.
        return refusalOf(error, 'TEAM_NOT_FOUND', firstLineOf);
      }
    }
    const restored = restoreConfigDirs(checked.team, current?.team ?? null);
    if (!restored.ok) {
      return {
        ok: false,
        code: 'CONFIG_DIR_UNKNOWN',
        message: restored.message,
      };
    }
    const team = restored.team;
    // A refusal from here on may quote a path just put back (a profile folder
    // that no longer exists): it goes to the agent as its token.
    const hidePaths = (text: string): string => redactConfigDirText(text, team);
    try {
      await this.executor.assertRunnable(team);
    } catch (error) {
      // The graph checks refuse with geniro's exceptions; the model check
      // (`AgentAdapter.validateModel`) throws plain errors, in geniro's own
      // words and quoting at most the local Ollama server's answer — its
      // reason is what lets the agent pick another model.
      return error instanceof BaseException || !(error instanceof Error)
        ? refusalOf(error, 'NOT_RUNNABLE', hidePaths)
        : {
            ok: false,
            code: 'MODEL_UNAVAILABLE',
            message: hidePaths(error.message).slice(0, MAX_REFUSAL_LENGTH),
          };
    }
    const summarized = summarizedFor(team, request);
    if (current === null) {
      return {
        ok: true,
        proposal: {
          mode: 'create',
          ...summarized,
          slug: await this.store.freeDerivedSlug(team.name),
          team,
        },
      };
    }
    const diff = diffTeams(current.team, team);
    if (diff.identical) {
      return {
        ok: false,
        code: 'NOTHING_TO_CHANGE',
        message: `the proposal is identical to '${current.slug}' as it stands`,
      };
    }
    return {
      ok: true,
      proposal: {
        mode: 'replace',
        ...summarized,
        slug: current.slug,
        replacesName: current.team.name,
        diff,
        baseHash: current.hash,
        team,
      },
    };
  }

  /**
   * A builder chat's edits, applied to the library file as it stands and
   * checked as its own save would be — the schema and the graph rules, not
   * whether it could run yet: a team is built up over several changes. The
   * card is a replacement pinned to the version the edits were applied to.
   */
  async prepareChange(
    request: TeamChangeProposalRequest,
  ): Promise<PreparedProposal> {
    const file = await readTeamSource(
      this.store.locate(request.slug).path,
    ).catch(() => null);
    if (file === null) {
      return {
        ok: false,
        code: 'TEAM_GONE',
        message: `the team '${request.slug}' is no longer in the library — it is not re-created`,
      };
    }
    let current: Team;
    try {
      current = parseTeamYaml(file.source);
    } catch (error) {
      // The parser quotes the file's lines around the fault, a profile path
      // among them: the agent gets the first line, which names the fault.
      return {
        ok: false,
        code: 'TEAM_UNREADABLE',
        message: `the file cannot be loaded (${firstLineOf(error instanceof Error ? error.message : String(error))}) — fix only what this names, in the file, with your own file tools, then propose the change again`,
      };
    }
    const edited = editTeam(current, request.edits, TEAM_FILE_EDIT_COPY, true);
    if (!edited.ok) {
      return { ok: false, code: edited.error, message: edited.message };
    }
    const team = edited.team;
    const diff = diffTeams(current, team);
    if (diff.identical) {
      return {
        ok: false,
        code: 'NOTHING_TO_CHANGE',
        message: `the edits leave '${request.slug}' as it stands`,
      };
    }
    return {
      ok: true,
      proposal: {
        mode: 'replace',
        ...summarizedFor(team, request),
        slug: request.slug,
        replacesName: current.name,
        diff,
        baseHash: file.hash,
        team,
      },
    };
  }

  /**
   * Write an approved card, and log what it wrote under the chat that raised
   * it (`by`) and the note the user typed on it.
   */
  async apply(
    proposal: TeamProposal,
    by: { runId: string; note: string | null } | null = null,
  ): Promise<AppliedProposal> {
    if (proposal.mode === 'create') {
      try {
        await this.store.create(proposal.team, proposal.slug);
      } catch (error) {
        if (isConflict(error, 'TEAM_EXISTS')) {
          return { outcome: 'exists' };
        }
        throw error;
      }
      await this.logApproved(proposal, null, null, by);
      return { outcome: 'saved', slug: proposal.slug, backup: null };
    }
    const { directory, path } = this.store.locate(proposal.slug);
    const current = await readTeamSource(path);
    if (current === null) {
      return { outcome: 'gone' };
    }
    // Compared BEFORE the backup, so a press that loses to a newer save leaves
    // no copy of a version nobody approved replacing.
    if (current.hash !== proposal.baseHash) {
      return { outcome: 'changed' };
    }
    const backup = await backUpTeam(directory, proposal.slug, current.source);
    try {
      await this.store.save(proposal.slug, proposal.team, proposal.baseHash);
    } catch (error) {
      if (isConflict(error, 'TEAM_CHANGED')) {
        return { outcome: 'changed' };
      }
      throw error;
    }
    await this.logApproved(proposal, readableTeam(current.source), backup, by);
    return { outcome: 'saved', slug: proposal.slug, backup };
  }

  /**
   * The change log's entry for an approved card. A builder chat's card names
   * the recommendation ids it carries out in its reason (its brief asks it
   * to), so they are read from there.
   */
  private async logApproved(
    proposal: TeamProposal,
    before: Team | null,
    backup: string | null,
    by: { runId: string; note: string | null } | null,
  ): Promise<void> {
    const chat =
      by === null
        ? null
        : await this.runDao.getById(by.runId, this.em.fork()).catch(() => null);
    const builder = (chat?.editsTeamSlug ?? null) === proposal.slug;
    await this.changeLog.record({
      slug: proposal.slug,
      source: builder ? 'builder' : 'chat',
      before,
      after: proposal.team,
      summary: proposal.summary,
      reason: proposal.reason,
      userNote: by?.note,
      recommendationIds: builder
        ? teamItemIdsIn(`${proposal.summary ?? ''}\n${proposal.reason ?? ''}`)
        : [],
      chatRunId: by?.runId,
      backup,
    });
  }
}

/** The team a library file holds, or null when it does not parse. */
function readableTeam(source: string): Team | null {
  try {
    return parseTeamYaml(source);
  } catch {
    return null;
  }
}

/** Every team recommendation id (`W-2`) a text names, in order. */
function teamItemIdsIn(text: string): string[] {
  return [...text.matchAll(/\bW-\d{1,3}\b/g)].map((match) => match[0]);
}

/**
 * What every card leads with. Ahead of `team`: the generic card prints its
 * input as JSON in a short scroll box, and this is what must be seen.
 */
function summarizedFor(
  team: Team,
  request: { summary?: string; reason?: string },
): Pick<TeamProposal, 'autoAgents' | 'summary' | 'reason'> {
  const summary = request.summary?.trim();
  const reason = request.reason?.trim();
  return {
    autoAgents: agentsThatRunAuto(team),
    ...(summary ? { summary } : {}),
    ...(reason ? { reason } : {}),
  };
}

function verdictOf(
  proposal: TeamProposal,
  applied: AppliedProposal,
  note: string | null,
): TeamProposalVerdict {
  switch (applied.outcome) {
    case 'saved':
      return {
        kind: 'saved',
        slug: applied.slug,
        backup: applied.backup,
        note,
      };
    case 'changed':
      return {
        kind: 'not-saved',
        cause: 'changed',
        reason: `the team '${proposal.slug}' changed after you proposed replacing it`,
        note,
      };
    case 'exists':
      return {
        kind: 'not-saved',
        cause: 'exists',
        reason: `a team was saved as '${proposal.slug}' after you proposed this one`,
        note,
      };
    case 'gone':
      return {
        kind: 'not-saved',
        cause: 'gone',
        reason: `the team '${proposal.slug}' was deleted after you proposed replacing it`,
        note,
      };
  }
}

/** What the card shows of an approval; a decline needs nothing beyond `allow`. */
function outcomeOf(
  verdict: TeamProposalVerdict,
): TeamProposalOutcome | undefined {
  switch (verdict.kind) {
    case 'saved':
      return { kind: 'saved', slug: verdict.slug };
    case 'not-saved':
      return { kind: 'not-saved', cause: verdict.cause };
    case 'declined':
      return undefined;
  }
}

/** How much of a model check's own message the agent is told. */
const MAX_REFUSAL_LENGTH = 300;

/** How far a proposal got before it failed — what {@link TeamProposalService.undoRaise} unwinds. */
interface RaiseProgress {
  standing: PendingTeamProposal | null;
  /** `started` = the old card's entry may be gone with no row written. */
  retire: 'none' | 'started' | 'done';
  raised: boolean;
}

/** `Run.pendingTeamProposal`, or null when absent or unreadable. */
function readPending(value: string | null): PendingTeamProposal | null {
  if (value === null) {
    return null;
  }
  try {
    const parsed = PendingTeamProposalSchema.safeParse(
      fromLegacyPendingProposal(JSON.parse(value)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * A check's refusal as the agent is told it: geniro's own refusal in its own
 * words, anything else only by `fallbackCode` — its text can name local paths
 * or hosts, and it goes to a model whose provider is off this machine.
 */
function refusalOf(
  error: unknown,
  fallbackCode: string,
  shown: (message: string) => string,
): Extract<PreparedProposal, { ok: false }> {
  return error instanceof BaseException
    ? { ok: false, code: error.errorCode, message: shown(error.message) }
    : {
        ok: false,
        code: fallbackCode,
        message: 'the check could not be completed',
      };
}

function isConflict(error: unknown, code: string): boolean {
  return error instanceof ConflictException && error.errorCode === code;
}

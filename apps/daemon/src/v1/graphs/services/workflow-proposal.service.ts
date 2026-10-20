import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import { BaseException, ConflictException } from '@packages/common';

import {
  type DeferredCardResponder,
  HOST_PROPOSE_WORKFLOW_TOOL,
  type WorkflowProposalVerdict,
} from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { ChatService } from '../../agents/services/chat.service';
import {
  standingProposalCardId,
  workflowVerdictMessage,
} from '../../agents/utils/host-workflows';
import {
  type PendingWorkflowProposal,
  PendingWorkflowProposalSchema,
  type ProposalOutcome,
  type WorkflowProposal,
  type WorkflowProposalRequest,
} from '../graphs.types';
import {
  firstLineOf,
  redactConfigDirText,
  restoreConfigDirs,
} from '../utils/config-dir-redaction';
import { agentsThatRunAuto } from '../utils/unattended';
import { backUpWorkflow, readWorkflowSource } from '../utils/workflow-backup';
import { checkWorkflow } from '../utils/workflow-check';
import { diffWorkflows } from '../utils/workflow-diff';
import { GraphExecutorService } from './graph-executor.service';
import { WorkflowStoreService } from './workflow-store.service';

export type PreparedProposal =
  | { ok: true; proposal: WorkflowProposal }
  | { ok: false; code: string; message: string };

export type AppliedProposal =
  | { outcome: 'saved'; slug: string; backup: string | null }
  /** A replacement whose file changed since the card was raised. */
  | { outcome: 'changed' }
  /** A new workflow whose slug was taken since the card was raised. */
  | { outcome: 'exists' }
  /** A replacement whose file was deleted since the card was raised. */
  | { outcome: 'gone' };

/**
 * The one path an agent's whole-workflow proposal reaches the library by.
 *
 * `prepare` decides everything the card shows — whether the workflow could run
 * at all, the file it would write, and against which version — so the user
 * approves exactly what will be written. `apply` writes it only if that is
 * still true, backing a replaced file up first.
 *
 * The card is a deferred one (`ChatService.raiseOwnedCard`): the agent is
 * answered at once and told to stop, the card waits on the user with no
 * deadline, and the verdict reaches the agent as the run's next message. One
 * card stands per run, in `Run.pendingWorkflowProposal`; only a newer proposal
 * or an archive retires it (a typed message does not), and it is put back at
 * boot.
 *
 * In `v1/graphs` because the store and the run-start checks are; `v1/agents`
 * may not import it.
 */
@Injectable()
export class WorkflowProposalService {
  private readonly logger = new Logger(WorkflowProposalService.name);

  /** The proposal being raised per run, so two in one tick never both stand. */
  private readonly raising = new Map<string, Promise<unknown>>();

  /** Cards the user has pressed whose answer is still being carried out. */
  private readonly answering = new Set<string>();

  constructor(
    private readonly store: WorkflowStoreService,
    private readonly executor: GraphExecutorService,
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly chats: ChatService,
  ) {}

  /**
   * Check a proposal and, if it holds, put its card up in place of the run's
   * standing one. Raised one at a time per run: the standing card is read
   * before the new one is written, so two racing proposals would otherwise
   * both find nothing standing and both stay on screen.
   */
  async propose(
    runId: string,
    request: WorkflowProposalRequest,
  ): Promise<ProposalOutcome> {
    const previous = this.raising.get(runId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.proposeNow(runId, request));
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
    request: WorkflowProposalRequest,
  ): Promise<ProposalOutcome> {
    const prepared = await this.prepare(request);
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
        (await this.runDao.getById(runId, em))?.pendingWorkflowProposal ?? null,
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
          HOST_PROPOSE_WORKFLOW_TOOL,
        );
        done.retire = 'done';
      }
      await this.chats.raiseOwnedCard(
        runId,
        requestId,
        { toolName: HOST_PROPOSE_WORKFLOW_TOOL, input: proposal },
        this.responderFor(runId, requestId, proposal),
      );
      done.raised = true;
      // AFTER the row: the column points at it, and a pointer written first
      // would survive a failed write as a card nothing ever drew.
      await this.runDao.setPendingWorkflowProposal(
        runId,
        JSON.stringify({
          requestId,
          proposal,
        } satisfies PendingWorkflowProposal),
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
        `run ${runId} could not put a workflow proposal on screen: ${error instanceof Error ? error.message : String(error)}`,
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
          HOST_PROPOSE_WORKFLOW_TOOL,
        );
      }
      if (done.retire === 'started' && done.standing !== null) {
        this.chats.trackOwnedCard(
          runId,
          done.standing.requestId,
          {
            toolName: HOST_PROPOSE_WORKFLOW_TOOL,
            input: done.standing.proposal,
          },
          this.responderFor(
            runId,
            done.standing.requestId,
            done.standing.proposal,
          ),
        );
      } else if (done.retire === 'done' || done.raised) {
        await this.runDao.setPendingWorkflowProposal(
          runId,
          null,
          this.em.fork(),
        );
      }
    } catch (error) {
      this.logger.error(
        `run ${runId} could not undo a workflow proposal: ${error instanceof Error ? error.message : String(error)}`,
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
    let runs: Awaited<
      ReturnType<RunDao['listRunsWithPendingWorkflowProposal']>
    >;
    try {
      runs = await this.runDao.listRunsWithPendingWorkflowProposal(
        this.em.fork(),
      );
    } catch (error) {
      this.logger.error(
        `workflow proposal rehydration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    let restored = 0;
    for (const run of runs) {
      try {
        if (await this.rehydrateRun(run.id, run.pendingWorkflowProposal)) {
          restored += 1;
        }
      } catch (error) {
        this.logger.error(
          `run ${run.id} workflow proposal rehydration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (restored > 0) {
      this.logger.log(`restored ${restored} workflow proposal card(s)`);
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
      await this.chats.retireOwnedCard(
        runId,
        cardId,
        HOST_PROPOSE_WORKFLOW_TOOL,
      );
    }
    if (pending === null || closed) {
      await this.runDao.setPendingWorkflowProposal(runId, null, em);
      return false;
    }
    this.chats.trackOwnedCard(
      runId,
      pending.requestId,
      { toolName: HOST_PROPOSE_WORKFLOW_TOOL, input: pending.proposal },
      this.responderFor(runId, pending.requestId, pending.proposal),
    );
    return true;
  }

  private responderFor(
    runId: string,
    requestId: string,
    proposal: WorkflowProposal,
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
    proposal: WorkflowProposal,
    allow: boolean,
    answer: string | undefined,
  ): Promise<void> {
    const note = answer ?? null;
    let verdict: WorkflowProposalVerdict = { kind: 'declined', note };
    let cleared = true;
    try {
      await this.runDao.setPendingWorkflowProposal(runId, null, this.em.fork());
    } catch (error) {
      cleared = false;
      this.logger.error(
        `run ${runId} could not close a workflow proposal card: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (allow && !cleared) {
      // A card still standing in the column comes back at the next boot, so a
      // write now could be followed by a second one.
      verdict = {
        kind: 'not-saved',
        reason: 'the card could not be closed, so nothing was written',
        note,
      };
    } else if (allow) {
      try {
        verdict = verdictOf(proposal, await this.apply(proposal), note);
      } catch (error) {
        this.logger.error(
          `run ${runId} could not save an approved workflow: ${error instanceof Error ? error.message : String(error)}`,
        );
        verdict = {
          kind: 'not-saved',
          reason: 'the file could not be written',
          note,
        };
      }
    }
    await this.chats.deliverOwnedCardVerdict(
      runId,
      requestId,
      allow,
      workflowVerdictMessage(verdict),
      answer,
    );
  }

  async prepare(request: WorkflowProposalRequest): Promise<PreparedProposal> {
    const checked = checkWorkflow(request.workflow);
    if (!checked.ok) {
      return { ok: false, code: checked.code, message: checked.message };
    }
    // The workflow it replaces first: a `configDir` the agent read as a token
    // is put back before the workflow is checked as runnable, diffed or shown
    // (the schema check above takes a token as it takes any path).
    let current: Awaited<ReturnType<WorkflowStoreService['get']>> | null = null;
    if (request.replaces !== undefined) {
      try {
        current = await this.store.get(request.replaces);
      } catch (error) {
        // A YAML parse error quotes the file's lines around the fault, a
        // profile path among them: the agent gets its first line only.
        return refusalOf(error, 'WORKFLOW_NOT_FOUND', firstLineOf);
      }
    }
    const restored = restoreConfigDirs(
      checked.workflow,
      current?.workflow ?? null,
    );
    if (!restored.ok) {
      return {
        ok: false,
        code: 'CONFIG_DIR_UNKNOWN',
        message: restored.message,
      };
    }
    const workflow = restored.workflow;
    // A refusal from here on may quote a path just put back (a profile folder
    // that no longer exists): it goes to the agent as its token.
    const hidePaths = (text: string): string =>
      redactConfigDirText(text, workflow);
    try {
      await this.executor.assertRunnable(workflow);
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
    const summary = request.summary?.trim();
    // Ahead of `workflow` in each card below: the generic card prints its
    // input as JSON in a short scroll box, and this is what must be seen.
    const summarized = {
      autoAgents: agentsThatRunAuto(workflow),
      ...(summary ? { summary } : {}),
    };
    if (current === null) {
      return {
        ok: true,
        proposal: {
          mode: 'create',
          ...summarized,
          slug: await this.store.freeDerivedSlug(workflow.name),
          workflow,
        },
      };
    }
    const diff = diffWorkflows(current.workflow, workflow);
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
        replacesName: current.workflow.name,
        diff,
        baseHash: current.hash,
        workflow,
      },
    };
  }

  async apply(proposal: WorkflowProposal): Promise<AppliedProposal> {
    if (proposal.mode === 'create') {
      try {
        await this.store.create(proposal.workflow, proposal.slug);
      } catch (error) {
        if (isConflict(error, 'WORKFLOW_EXISTS')) {
          return { outcome: 'exists' };
        }
        throw error;
      }
      return { outcome: 'saved', slug: proposal.slug, backup: null };
    }
    const { directory, path } = this.store.locate(proposal.slug);
    const current = await readWorkflowSource(path);
    if (current === null) {
      return { outcome: 'gone' };
    }
    // Compared BEFORE the backup, so a press that loses to a newer save leaves
    // no copy of a version nobody approved replacing.
    if (current.hash !== proposal.baseHash) {
      return { outcome: 'changed' };
    }
    const backup = await backUpWorkflow(
      directory,
      proposal.slug,
      current.source,
    );
    try {
      await this.store.save(
        proposal.slug,
        proposal.workflow,
        proposal.baseHash,
      );
    } catch (error) {
      if (isConflict(error, 'WORKFLOW_CHANGED')) {
        return { outcome: 'changed' };
      }
      throw error;
    }
    return { outcome: 'saved', slug: proposal.slug, backup };
  }
}

function verdictOf(
  proposal: WorkflowProposal,
  applied: AppliedProposal,
  note: string | null,
): WorkflowProposalVerdict {
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
        reason: `the workflow '${proposal.slug}' changed after you proposed replacing it`,
        note,
      };
    case 'exists':
      return {
        kind: 'not-saved',
        reason: `a workflow was saved as '${proposal.slug}' after you proposed this one`,
        note,
      };
    case 'gone':
      return {
        kind: 'not-saved',
        reason: `the workflow '${proposal.slug}' was deleted after you proposed replacing it`,
        note,
      };
  }
}

/** How much of a model check's own message the agent is told. */
const MAX_REFUSAL_LENGTH = 300;

/** How far a proposal got before it failed — what {@link WorkflowProposalService.undoRaise} unwinds. */
interface RaiseProgress {
  standing: PendingWorkflowProposal | null;
  /** `started` = the old card's entry may be gone with no row written. */
  retire: 'none' | 'started' | 'done';
  raised: boolean;
}

/** `Run.pendingWorkflowProposal`, or null when absent or unreadable. */
function readPending(value: string | null): PendingWorkflowProposal | null {
  if (value === null) {
    return null;
  }
  try {
    const parsed = PendingWorkflowProposalSchema.safeParse(JSON.parse(value));
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

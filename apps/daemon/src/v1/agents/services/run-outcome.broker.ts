import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import type { ItemKind } from '../../runs/runs.types';
import {
  HOST_QUESTION_TOOL,
  type ItemWire,
  type RunOutcomeInput,
  type RunOutcomePayload,
  type RunOutcomeWriteOutcome,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { asRecord, asString } from '../utils/json-util';
import { pullRequestOutcomeKey } from '../utils/pull-request-capture';
import { parsePullRequestUrl, withRunOutcome } from '../utils/run-outcomes';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { HostSinkBroker, type HostSinkUnavailable } from './host-sink.broker';
import { PullRequestCaptureService } from './pull-request-capture.service';

/** The conversation behind a `record_outcome` call. */
export interface RunOutcomeRecorder {
  nodeId: string;
  /** Null for the node's own conversation. */
  conversationId: string | null;
  /** The call that conversation is answering right now, if any. */
  callId: string | null;
}

/**
 * One workflow node's end of `record_outcome`, installed by the pass that runs
 * it: the run's seq-allocating write, and which conversation a caller key is.
 */
export interface RunOutcomeSink {
  persistItem(
    nodeId: string | null,
    kind: ItemKind,
    role: string | null,
    payload: unknown,
  ): Promise<ItemWire>;
  recorder(caller: string): RunOutcomeRecorder;
}

/**
 * How many questions one question card put to the user: its normalized
 * `questions` when the row carries them, else the CLI's own `input.questions`
 * (rows written before the normalized field), else one.
 */
function questionsOnCard(payload: Record<string, unknown>): number {
  if (Array.isArray(payload.questions) && payload.questions.length > 0) {
    return payload.questions.length;
  }
  const input = asRecord(payload.input);
  if (Array.isArray(input?.questions) && input.questions.length > 0) {
    return input.questions.length;
  }
  return 1;
}

/**
 * `record_outcome`: a workflow node records where one pull request of its run
 * ended up. The `run_outcome` row is the record; the run's `runOutcomes`
 * column keeps the newest per pull request for the run's wire projection, and
 * the stats module copies each row into its ledger (`RunOutcomeLedgerService`
 * there), which outlives the run.
 *
 * `questionsAsked` is counted here, over every question card of the run, never
 * taken from the agent: a remembered number drifts, the rows do not.
 */
@Injectable()
export class RunOutcomeBroker extends HostSinkBroker<RunOutcomeSink> {
  private readonly log = new Logger(RunOutcomeBroker.name);
  /** Per run, the tail of its write chain. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    private readonly runDao: RunDao,
    private readonly adapters: AgentAdapterRegistry,
    private readonly captures: PullRequestCaptureService,
  ) {
    super();
  }

  /** Whether this node is offered `record_outcome`. */
  canUse(runId: string, nodeId: string): boolean {
    return this.has(runId, nodeId);
  }

  async record(
    runId: string,
    nodeId: string,
    caller: string,
    input: RunOutcomeInput,
  ): Promise<RunOutcomeWriteOutcome | HostSinkUnavailable> {
    return this.deliver(
      runId,
      nodeId,
      'no workflow pass is running that could record it',
      'record a pull request outcome',
      (sink) =>
        this.serialized(runId, () =>
          this.recordNow(runId, nodeId, caller, input, sink),
        ),
    );
  }

  forgetRun(runId: string): void {
    this.chains.delete(runId);
  }

  private async recordNow(
    runId: string,
    nodeId: string,
    caller: string,
    input: RunOutcomeInput,
    sink: RunOutcomeSink,
  ): Promise<RunOutcomeWriteOutcome> {
    const pullRequest = parsePullRequestUrl(input.prUrl);
    if (pullRequest === null) {
      return {
        status: 'refused',
        reason: `pr_url is not a github.com pull request URL (https://github.com/<owner>/<repo>/pull/<number>)`,
      };
    }
    if (pullRequest.number !== input.prNumber) {
      return {
        status: 'refused',
        reason: `pr_number ${input.prNumber} does not match pr_url, which names #${pullRequest.number}`,
      };
    }
    const em = this.em.fork();
    const run = await this.runDao.outcomeContextOf(runId, em);
    if (run === null) {
      return { status: 'refused', reason: 'this run no longer exists' };
    }
    const questionsAsked = await this.questionsAsked(runId, em);
    const recorder = sink.recorder(caller);
    const payload: RunOutcomePayload = {
      prOwner: pullRequest.owner,
      prRepo: pullRequest.repo,
      prNumber: pullRequest.number,
      prUrl: input.prUrl,
      draft: input.draft,
      reviewRounds: input.reviewRounds,
      acceptance: input.acceptance,
      questionsAsked,
      workflowSlug: run.workflowId,
      nodeId: recorder.nodeId,
      conversationId: recorder.conversationId,
      ...(recorder.callId === null ? {} : { callId: recorder.callId }),
    };
    const item = await sink.persistItem(nodeId, 'run_outcome', null, payload);
    // The row is the record; the column only feeds the run's wire projection.
    // A failure past this point is logged and never refuses the call, which
    // would have the agent record the same outcome again.
    try {
      const runOutcomes = withRunOutcome(run.runOutcomes, pullRequest, {
        seq: item.seq,
        draft: payload.draft,
        reviewRounds: payload.reviewRounds,
        acceptance: payload.acceptance,
        questionsAsked,
      });
      await this.runDao.updateWithoutActivity(runId, { runOutcomes }, em);
      // Through the capture pass's per-run order: it announces the same list,
      // and two independent announces could each re-send a list the other had
      // already moved. Queued, not awaited — the order is fixed at the call,
      // and a rescan in flight can take seconds the agent need not wait.
      void this.captures
        .announceOutcome(runId, pullRequestOutcomeKey(pullRequest))
        .catch((err: unknown) => {
          this.log.warn(
            `run ${runId} could not announce its pull requests: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    } catch (err) {
      this.log.warn(
        `run ${runId} recorded outcome row ${item.seq} but could not update its pull-request list: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { status: 'recorded', seq: item.seq, questionsAsked };
  }

  /** Every question put to the user on this run so far, by any of its agents. */
  private async questionsAsked(
    runId: string,
    em: EntityManager,
  ): Promise<number> {
    const questionTools = new Set<string>([HOST_QUESTION_TOOL]);
    for (const adapter of this.adapters.all().values()) {
      const name = adapter.getConfig().questionToolName;
      if (name !== null) {
        questionTools.add(name);
      }
    }
    const rows = await this.itemDao.rowsOfKinds(
      runId,
      ['approval_request'],
      undefined,
      em,
    );
    let count = 0;
    for (const row of rows) {
      const payload = asRecord(row.payload);
      const toolName = asString(payload?.toolName);
      if (
        payload !== null &&
        toolName !== null &&
        questionTools.has(toolName)
      ) {
        count += questionsOnCard(payload);
      }
    }
    return count;
  }

  /**
   * Run one write of this run after the previous one settles, so two outcomes
   * recorded together update the column one after the other.
   */
  private serialized<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(runId) ?? Promise.resolve();
    const next = previous.then(work);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(runId, tail);
    void tail.then(() => {
      if (this.chains.get(runId) === tail) {
        this.chains.delete(runId);
      }
    });
    return next;
  }
}

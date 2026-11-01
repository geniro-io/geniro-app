import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import type { ItemKind } from '../../runs/runs.types';
import {
  type ItemWire,
  type PullRequestOutcome,
  type RunOutcomeInput,
  type RunOutcomePayload,
  type RunOutcomeWriteOutcome,
} from '../chat.types';
import { RunDao } from '../dao/run.dao';
import { KeyedChain } from '../utils/keyed-chain';
import { pullRequestOutcomeKey } from '../utils/pull-request-capture';
import {
  parsePullRequestUrl,
  type PullRequestIdentity,
  readRunOutcomes,
  withRunOutcome,
} from '../utils/run-outcomes';
import { HostSinkBroker, type HostSinkUnavailable } from './host-sink.broker';
import { PullRequestCaptureService } from './pull-request-capture.service';
import { RunOutcomeHistoryService } from './run-outcome-history.service';

/** The conversation behind a `record_outcome` call. */
export interface RunOutcomeRecorder {
  nodeId: string;
  /** Null for the node's own conversation. */
  conversationId: string | null;
  /** The call that conversation is answering right now, if any. */
  callId: string | null;
}

/**
 * One team node's end of `record_outcome`, installed by the pass that runs
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
 * `record_outcome`: a team node records where one pull request of its run
 * ended up. The `run_outcome` row is the record; the run's `runOutcomes`
 * column keeps the newest per pull request for the run's wire projection, and
 * the stats module copies each row into its ledger (`RunOutcomeLedgerService`
 * there), which outlives the run.
 *
 * `questionsAsked` is counted by {@link RunOutcomeHistoryService} over every
 * question card of the run, never taken from the agent: a remembered number
 * drifts, the rows do not.
 */
@Injectable()
export class RunOutcomeBroker extends HostSinkBroker<RunOutcomeSink> {
  private readonly log = new Logger(RunOutcomeBroker.name);
  /** Per run, the tail of its write chain. */
  private readonly writes = new KeyedChain();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly history: RunOutcomeHistoryService,
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
      'no team pass is running that could record it',
      'record a pull request outcome',
      (sink) =>
        this.writes.run(runId, () =>
          this.recordNow(runId, nodeId, caller, input, sink),
        ),
    );
  }

  forgetRun(runId: string): void {
    this.writes.forget(runId);
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
    const key = pullRequestOutcomeKey(pullRequest);
    const history = await this.history.read(runId, undefined, em);
    const newest = history.pullRequests.find(
      (entry) => pullRequestOutcomeKey(entry) === key,
    )?.outcomes[0];
    // A column write that failed earlier is caught up by the next call, for
    // whichever pull request it records.
    const column = readRunOutcomes(run.runOutcomes);
    const lagging = history.pullRequests.flatMap((entry) => {
      const outcome = entry.outcomes[0];
      return outcome !== undefined &&
        column.get(pullRequestOutcomeKey(entry))?.seq !== outcome.seq
        ? [{ pullRequest: entry, outcome }]
        : [];
    });
    if (
      newest !== undefined &&
      newest.draft === input.draft &&
      newest.reviewRounds === input.reviewRounds &&
      newest.acceptance === input.acceptance
    ) {
      if (lagging.length > 0) {
        await this.writeColumn(runId, run.runOutcomes, lagging, em);
      }
      return { status: 'unchanged', seq: newest.seq };
    }
    const questionsAsked = history.questionsAsked;
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
      ...(input.summary === null ? {} : { summary: input.summary }),
      teamSlug: run.teamId,
      nodeId: recorder.nodeId,
      conversationId: recorder.conversationId,
      ...(recorder.callId === null ? {} : { callId: recorder.callId }),
    };
    const item = await sink.persistItem(nodeId, 'run_outcome', null, payload);
    await this.writeColumn(
      runId,
      run.runOutcomes,
      [
        ...lagging.filter(
          (entry) => pullRequestOutcomeKey(entry.pullRequest) !== key,
        ),
        { pullRequest, outcome: { seq: item.seq, ...payload } },
      ],
      em,
    );
    return { status: 'recorded', seq: item.seq, questionsAsked };
  }

  /**
   * Keep the run's newest outcome per pull request in its column and
   * announce the list. The row is the record; the column only feeds the
   * run's wire projection, so a failure here is logged and never refuses the
   * call, which would have the agent record the same outcome again.
   */
  private async writeColumn(
    runId: string,
    column: string | null,
    outcomes: readonly {
      pullRequest: PullRequestIdentity;
      outcome: PullRequestOutcome;
    }[],
    em: EntityManager,
  ): Promise<void> {
    try {
      let runOutcomes = column;
      for (const { pullRequest, outcome } of outcomes) {
        runOutcomes = withRunOutcome(runOutcomes, pullRequest, {
          seq: outcome.seq,
          draft: outcome.draft,
          reviewRounds: outcome.reviewRounds,
          acceptance: outcome.acceptance,
          questionsAsked: outcome.questionsAsked,
        });
      }
      await this.runDao.updateWithoutActivity(runId, { runOutcomes }, em);
      // Through the capture pass's per-run order: it announces the same list,
      // and two independent announces could each re-send a list the other had
      // already moved. Queued, not awaited — the order is fixed at the call,
      // and a rescan in flight can take seconds the agent need not wait.
      for (const { pullRequest } of outcomes) {
        void this.captures
          .announceOutcome(runId, pullRequestOutcomeKey(pullRequest))
          .catch((err: unknown) => {
            this.log.warn(
              `run ${runId} could not announce its pull requests: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }
    } catch (err) {
      this.log.warn(
        `run ${runId} recorded outcome rows ${outcomes.map(({ outcome }) => outcome.seq).join(', ')} but could not update its pull-request list: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

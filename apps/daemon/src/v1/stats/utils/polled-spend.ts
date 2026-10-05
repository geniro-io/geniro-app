import type { NodeState } from '../../runs/entity/node-state.entity';
import type { Run } from '../../runs/entity/run.entity';
import type { AgentKind } from '../../runs/runs.types';
import type { UsageEvent } from '../entity/usage-event.entity';
import { POLLED_SPEND_SEQ, type UsageEventInput } from '../stats.types';
import { usageDimensions } from './usage-dimensions';

/**
 * Every run column {@link polledSpendRow} reads — the projection a sweep over
 * priced runs loads. Typed through {@link PolledSpendRun}, so reading one more
 * column without listing it here does not compile.
 */
export const POLLED_SPEND_RUN_FIELDS = [
  'id',
  'polledCostCents',
  'updatedAt',
  'agentKind',
  'model',
  'cwd',
  'workflowId',
  'workflowSnapshot',
] as const satisfies readonly (keyof Run)[];

export type PolledSpendRun = Pick<
  Run,
  (typeof POLLED_SPEND_RUN_FIELDS)[number]
>;

/**
 * A run's POLLED spend as the one ledger row that carries it, or null when the
 * poll has priced nothing on this run.
 *
 * A polled-spend CLI (`AdapterConfig.usage.polledSpend` — cursor today) prices
 * nothing on its own wire, so its money reaches this app only through an
 * account poll that accumulates onto `Run.polledCostCents`. That column is
 * destroyed with the run, so Stats reading it straight off the run row would
 * take a deleted chat's whole bill out of every lifetime figure, which is
 * exactly the loss this ledger exists to prevent for turns. Copying the run's
 * running total here is what lets it outlive the run.
 *
 * Shared by the live recorder and the boot sweep, on `usageDimensions`' rule:
 * the two must write an identical row for the same run, or the figure would
 * depend on which of them got there last.
 *
 * - `agentKind` is the CLI whose money this is, resolved by the caller
 *   (`polledAgentKind`) and never read off the run alone: a WORKFLOW run — where
 *   a polled node's spend comes from — has no agent of its own, so reading it
 *   would file real polled money under the "unknown agent" row. It is ONE kind
 *   per run: exact for a run whose polled money is one CLI's, which is every run
 *   there can be while one CLI polls, and the largest share's CLI otherwise.
 * - `occurredAt` is the run's LAST ACTIVITY. That is an approximation and the
 *   deliberate one: the column is one running total for the whole conversation
 *   with no per-day resolution of its own, so a run worked across three days
 *   has its whole price placed on the last of them. An account's own response
 *   does carry a timestamp per chargeable event, so a per-day split, if ever
 *   wanted, means keeping those events rather than dating this row more
 *   cleverly.
 * - Every figure but the cost is null — the poll measures money and nothing
 *   else, and null means NOT MEASURED here as everywhere in this table.
 */
export function polledSpendRow(
  run: PolledSpendRun,
  agentKind: AgentKind | null,
  /**
   * The model this run's own turns of that CLI last REPORTED running on
   * (`UsageEventDao.latestReportedModel`) — the poll knows money and nothing
   * else, and a workflow run names no model of its own.
   */
  reportedModel: string | null = null,
): UsageEventInput | null {
  const cents = run.polledCostCents;
  if (cents === null || !(cents > 0)) {
    return null;
  }
  return {
    runId: run.id,
    nodeId: null,
    seq: POLLED_SPEND_SEQ,
    occurredAt: run.updatedAt,
    ...usageDimensions(run, null, reportedModel),
    agentKind,
    costUsd: cents / 100,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    thinkingTokens: null,
    durationMs: null,
    apiMs: null,
    ttftMs: null,
    timeToRequestMs: null,
    numTurns: null,
  };
}

/**
 * Whether a ledger row is a run's polled spend rather than a finished turn.
 *
 * Every reader that COUNTS turns must ask this first: the polled row is money
 * with no turn behind it, so folding it as one would add a phantom turn and
 * price it — see the polled-spend fold in `StatsService`.
 */
export function isPolledSpend(event: Pick<UsageEvent, 'seq'>): boolean {
  return event.seq === POLLED_SPEND_SEQ;
}

/**
 * The CLI a run's polled money belongs to. A chat's is its own agent's. A
 * workflow run names no agent, so its bill is the CLI of the node holding the
 * largest polled share — the per-node figures the poll records beside the run's
 * total — or null when no node carries one.
 */
export function polledAgentKind(
  run: Pick<Run, 'agentKind'>,
  shares: readonly Pick<NodeState, 'agentKind' | 'polledCostCents'>[],
): AgentKind | null {
  if (run.agentKind !== null) {
    return run.agentKind;
  }
  let kind: AgentKind | null = null;
  let largest = 0;
  for (const share of shares) {
    const cents = share.polledCostCents ?? 0;
    if (share.agentKind !== null && cents > largest) {
      kind = share.agentKind;
      largest = cents;
    }
  }
  return kind;
}

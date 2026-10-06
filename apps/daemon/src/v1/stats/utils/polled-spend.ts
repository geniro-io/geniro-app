import { parseJsonColumn } from '../../agents/utils/json-util';
import { readSpendBucket } from '../../agents/utils/polled-spend-ledger';
import type { NodeState } from '../../runs/entity/node-state.entity';
import type { Run } from '../../runs/entity/run.entity';
import type { AgentKind } from '../../runs/runs.types';
import type { UsageEvent } from '../entity/usage-event.entity';
import { POLLED_SPEND_SEQ, type UsageEventInput } from '../stats.types';
import { usageDimensions } from './usage-dimensions';

/**
 * Every run column {@link polledSpendRows} reads — the projection a sweep over
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
  'polledSpendBuckets',
] as const satisfies readonly (keyof Run)[];

export type PolledSpendRun = Pick<
  Run,
  (typeof POLLED_SPEND_RUN_FIELDS)[number]
>;

/**
 * A run's POLLED spend as the ledger rows that carry it — one per local
 * calendar day and model the account billed it under — or none when the poll
 * has priced nothing on this run.
 *
 * A polled-spend CLI (`AdapterConfig.usage.polledSpend` — cursor today) prices
 * nothing on its own wire, so its money reaches this app only through an
 * account poll that writes onto `Run.polledCostCents`, split by day and model
 * in `Run.polledSpendBuckets`. Those columns are destroyed with the run, so
 * Stats reading them straight off the run row would take a deleted chat's whole
 * bill out of every lifetime figure, which is exactly the loss this ledger
 * exists to prevent for turns. Copying them here is what lets them outlive it.
 *
 * Shared by the live recorder and the boot sweep, on `usageDimensions`' rule:
 * the two must write identical rows for the same run, or the figure would
 * depend on which of them got there last.
 *
 * - One row per bucket, so the Stats page draws the bill on the DAYS it was
 *   spent and under the MODELS that spent it. Before, one row per run placed a
 *   month of a workflow's cursor bill on its last day under no model — the
 *   "By model" list's largest entry was a blank. Rows are keyed
 *   `(runId, POLLED_SPEND_SEQ - i)` over the buckets in key order, and the
 *   whole set is replaced on every write (`UsageEventDao.recordPolledSpend`).
 * - A run with no buckets (priced before they were kept) keeps ONE row on its
 *   last activity, the approximation that row always was.
 * - A row the account named no model for is filed under `reportedModel`.
 * - `agentKind` is the CLI whose money this is, resolved by the caller
 *   (`polledAgentKind`) and never read off the run alone: a WORKFLOW run — where
 *   a polled node's spend comes from — has no agent of its own.
 * - Every figure but the cost is null — the poll measures money and nothing
 *   else, and null means NOT MEASURED here as everywhere in this table.
 */
export function polledSpendRows(
  run: PolledSpendRun,
  agentKind: AgentKind | null,
  /**
   * The model this run's own turns of that CLI last REPORTED running on
   * (`UsageEventDao.latestReportedModel`) — what a row is filed under when the
   * account named no model for it, since a workflow run names none of its own.
   */
  reportedModel: string | null = null,
): UsageEventInput[] {
  const cents = run.polledCostCents;
  if (cents === null || !(cents > 0)) {
    return [];
  }
  const buckets = readBuckets(run.polledSpendBuckets);
  const entries: { occurredAt: Date; model: string | null; cents: number }[] =
    buckets.length === 0
      ? [{ occurredAt: run.updatedAt, model: null, cents }]
      : buckets.map(([bucket, amount]) => {
          const { day, model } = readSpendBucket(bucket);
          return {
            occurredAt: localNoon(day),
            model: model === '' ? null : model,
            cents: amount,
          };
        });
  return entries.map((entry, index) => ({
    runId: run.id,
    nodeId: null,
    seq: POLLED_SPEND_SEQ - index,
    occurredAt: entry.occurredAt,
    ...usageDimensions(run, null, entry.model ?? reportedModel),
    agentKind,
    costUsd: entry.cents / 100,
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
  }));
}

/** The run's buckets in key order, dropping any entry that is not a figure. */
function readBuckets(raw: string | null): [string, number][] {
  const value = parseJsonColumn(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, number] => {
      const amount = entry[1];
      return (
        typeof amount === 'number' && Number.isFinite(amount) && amount > 0
      );
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

/** Noon of a local `YYYY-MM-DD`, so the row lands on that day in any bucketing. */
function localNoon(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1, 12);
}

/**
 * Whether a ledger row is a run's polled spend rather than a finished turn.
 *
 * Every reader that COUNTS turns must ask this first: the polled row is money
 * with no turn behind it, so folding it as one would add a phantom turn and
 * price it — see the polled-spend fold in `StatsService`.
 */
export function isPolledSpend(event: Pick<UsageEvent, 'seq'>): boolean {
  return event.seq <= POLLED_SPEND_SEQ;
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

import type { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import type { UsageEvent } from '../entity/usage-event.entity';
import { POLLED_SPEND_SEQ, type UsageEventInput } from '../stats.types';
import { usageDimensions } from './usage-dimensions';

/**
 * A run's POLLED spend as the one ledger row that carries it, or null when the
 * poll has priced nothing on this run.
 *
 * cursor-agent prices nothing on its own wire, so its money reaches this app
 * only through an account poll that accumulates onto `Run.cursorCostCents`. That
 * column is destroyed with the run, and Stats used to read it straight off the
 * run row — so deleting a cursor chat took its whole bill out of every lifetime
 * figure, which is exactly the loss this ledger exists to prevent for turns.
 * Copying the run's running total here is what lets it outlive the run.
 *
 * Shared by the live recorder and the boot sweep, on `usageDimensions`' rule:
 * the two must write an identical row for the same run, or the figure would
 * depend on which of them got there last.
 *
 * - `agentKind` is cursor-agent BY CONSTRUCTION, never the run's own: this
 *   column is cursor's price, and a WORKFLOW run — where a cursor node's spend
 *   comes from — has no agent of its own, so reading it would file real cursor
 *   money under the "unknown agent" row.
 * - `occurredAt` is the run's LAST ACTIVITY. That is an approximation and the
 *   deliberate one: the column is one running total for the whole conversation
 *   with no per-day resolution of its own, so a run worked across three days
 *   has its whole price placed on the last of them. Cursor's own response does
 *   carry a timestamp per chargeable event, so a per-day split, if ever wanted,
 *   means keeping those events rather than dating this row more cleverly.
 * - Every figure but the cost is null — the poll measures money and nothing
 *   else, and null means NOT MEASURED here as everywhere in this table.
 */
export function polledSpendRow(run: Run): UsageEventInput | null {
  const cents = run.cursorCostCents;
  if (cents === null || !(cents > 0)) {
    return null;
  }
  return {
    runId: run.id,
    nodeId: null,
    seq: POLLED_SPEND_SEQ,
    occurredAt: run.updatedAt,
    ...usageDimensions(run, null),
    agentKind: AgentKind.CursorAgent,
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

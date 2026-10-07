import {
  type AgentKind,
  AgentKindSchema,
  type ItemKind,
} from '../../runs/runs.types';
import type { AgentUsage } from '../adapters/adapter.types';
import type { ChatTotalsWire, TurnMember } from '../chat.types';
import { asNumber, asRecord, asString } from './json-util';

/**
 * One finished turn's measured usage, and the fold that totals many of them.
 *
 * Lives in `v1/agents/utils` — beside `json-util` and `persist-item` — because
 * BOTH consumers are inside the daemon: `services/chat-metrics.service.ts`
 * totals one chat's turns for the context panel, and `v1/stats` totals every
 * run's turns for the Stats page. Two independent implementations of the same
 * money rule is how the two surfaces come to report different figures for the
 * same turns, and the repo's "extract, never mirror" rule has its twin-parser
 * carve-out only where no shared module can span the two sides. One can here.
 *
 * The renderer's `chats/agent-activity.ts` remains a genuine TWIN PARSER of the
 * same `usage` object: an item payload is `z.unknown()` on the wire BY DESIGN,
 * so no generated type crosses to the renderer and no module is shared with it.
 * A field added to `AgentUsage` must be read in both places.
 */
/**
 * The measured fields, named through `AgentUsage` rather than restated.
 *
 * `Extract` is what ties the reader to the writer: the payload is written from
 * an `AgentUsage` (`utils/event-to-item.ts`) and read back as untyped JSON here,
 * so nothing else connects them. Rename a field on `AgentUsage` and `Extract`
 * silently drops it from this union — which makes the object literal below an
 * excess property and fails `check-types`, instead of quietly nulling that
 * figure for every turn and writing the null into an append-only ledger.
 */
type MeasuredUsageKey = Extract<
  keyof AgentUsage,
  | 'costUsd'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheCreationTokens'
  | 'thinkingTokens'
  | 'durationMs'
  | 'apiMs'
  | 'ttftMs'
  | 'timeToRequestMs'
  | 'numTurns'
>;

export type UsageFigures = Record<MeasuredUsageKey, number | null>;

/**
 * The transcript kinds a turn's usage can ride: its `turn_complete`, and the
 * `error` a turn that FAILED writes in its place (see the `error` event's
 * `usage`). Every spend read selects these, and a row carrying no usage is
 * skipped by {@link usageFiguresFrom}, so an ordinary failure adds nothing.
 */
export const USAGE_ITEM_KINDS: readonly ItemKind[] = [
  'turn_complete',
  'error',
  // A turn the user STOPPED: its result line carries what it spent too, and
  // the per-session ledger has already moved past it, so a spend dropped
  // here is dropped for good.
  'turn_cancelled',
];

/** Whether a row of this kind can carry a turn's usage — {@link USAGE_ITEM_KINDS}. */
export function carriesUsage(kind: string): boolean {
  return (USAGE_ITEM_KINDS as readonly string[]).includes(kind);
}

/**
 * Read one `turn_complete` payload's figures, or null when it carries no usage
 * at all.
 *
 * **This is the single point where "the CLI did not report it" becomes null**,
 * and every field is read independently for exactly that reason. A field this
 * returns as null was NOT MEASURED — never zero. cursor-agent reports no cost
 * unless its currency is USD, and no cache, thinking or timing figures at all,
 * so defaulting any of them here would turn that CLI's silence into a claim
 * about money — and, once written to the append-only usage ledger, into one no
 * later backfill would correct.
 */
export function usageFiguresFrom(payload: unknown): UsageFigures | null {
  const usage = asRecord(asRecord(payload)?.usage);
  if (!usage) {
    return null;
  }
  // `asNumber` answers null for a string, a NaN, an Infinity or a missing key,
  // so a version-volatile CLI payload degrades to "not measured" rather than
  // fabricating a figure or poisoning a total with NaN.
  return {
    costUsd: asNumber(usage.costUsd),
    inputTokens: asNumber(usage.inputTokens),
    outputTokens: asNumber(usage.outputTokens),
    cacheReadTokens: asNumber(usage.cacheReadTokens),
    cacheCreationTokens: asNumber(usage.cacheCreationTokens),
    thinkingTokens: asNumber(usage.thinkingTokens),
    durationMs: asNumber(usage.durationMs),
    apiMs: asNumber(usage.apiMs),
    ttftMs: asNumber(usage.ttftMs),
    timeToRequestMs: asNumber(usage.timeToRequestMs),
    numTurns: asNumber(usage.numTurns),
  };
}

/**
 * {@link usageFiguresFrom} over a payload still in its stored JSON form — what
 * both the chat totals and the ledger backfill read out of the `items` table.
 *
 * A payload that will not parse costs one turn's accounting, never the caller:
 * one unreadable row is not a reason to abandon the rest of a user's history.
 */
export function usageFiguresFromRaw(raw: string): UsageFigures | null {
  try {
    return usageFiguresFrom(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * A fresh, empty aggregate.
 *
 * Every figure starts null rather than 0, and the distinction is the whole
 * point: a period in which no turn reported a cost must read as "not measured",
 * never as "cost nothing".
 */
export function emptyTotals(): ChatTotalsWire {
  return {
    turns: 0,
    costedTurns: 0,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    thinkingTokens: null,
    workedMs: null,
  };
}

/**
 * Add one turn's figures into an aggregate, in place.
 *
 * A null contributes NOTHING rather than a zero — so a total stays null until
 * some turn actually reported that figure, and one CLI's silence never dilutes
 * another's measurement.
 */
export function addUsage(totals: ChatTotalsWire, figures: UsageFigures): void {
  totals.turns += 1;
  // Counted separately from `turns` so an average spend has a denominator that
  // matches its numerator: a turn whose CLI reported no cost contributed
  // nothing to `costUsd`, so counting it below the line halves the figure on a
  // mixed-agent period.
  if (figures.costUsd !== null) {
    totals.costedTurns += 1;
  }
  add(totals, 'costUsd', figures.costUsd);
  add(totals, 'inputTokens', figures.inputTokens);
  add(totals, 'outputTokens', figures.outputTokens);
  add(totals, 'cacheReadTokens', figures.cacheReadTokens);
  add(totals, 'cacheCreationTokens', figures.cacheCreationTokens);
  add(totals, 'thinkingTokens', figures.thinkingTokens);
  // The CLI's OWN working time where it reports one, and NO wall-clock
  // fallback: the renderer already owns that substitution for the per-turn row,
  // and a total mixing the two would be a figure with no single meaning.
  add(totals, 'workedMs', figures.durationMs);
}

/**
 * Add spend that was POLLED rather than reported by a turn.
 *
 * A polled-spend CLI prices nothing on its own wire — measured across a real
 * ledger, 0 of 82 cursor turns carry a cost where 3,359 of 3,359 claude turns
 * do — so the only figure that exists for it is the account-wide poll, which
 * lands on the RUN row as `polledCostCents`. Without this the Stats page
 * reported that spend as nothing at all.
 *
 * It is deliberately NOT {@link addUsage}. That one counts a TURN, and this is
 * not one: the turns are already in the ledger and already counted — what was
 * missing is only their price. Counting them again here would inflate every
 * turn figure on the page by the number of polled turns in the period.
 *
 * `costedTurns` DOES move, and that is not a contradiction. It is the
 * denominator of "cost per turn", and it only ever counted turns whose own
 * payload carried a price — so a polled turn was excluded from it precisely
 * BECAUSE its cost was unknown. Now that the run's price is known, those turns
 * are costed, and leaving them out would divide real money by a turn count that
 * excludes the turns that spent it.
 */
export function addPolledSpend(
  totals: ChatTotalsWire,
  costUsd: number,
  costedTurns: number,
): void {
  totals.costUsd = (totals.costUsd ?? 0) + costUsd;
  totals.costedTurns += costedTurns;
}

/** Total every turn in a set of stored `turn_complete` payloads. */
export function sumUsagePayloads(payloads: readonly string[]): ChatTotalsWire {
  const totals = emptyTotals();
  for (const raw of payloads) {
    const figures = usageFiguresFromRaw(raw);
    if (figures) {
      addUsage(totals, figures);
    }
  }
  return totals;
}

function add(
  totals: ChatTotalsWire,
  key: keyof Omit<ChatTotalsWire, 'turns'>,
  value: number | null,
): void {
  if (value !== null) {
    totals[key] = (totals[key] ?? 0) + value;
  }
}

/**
 * The pool member a turn ran on, when its usage row says so — a workflow
 * node's call that ran on another of its pool members. Null for every other
 * turn, whose CLI is its node's (or its run's) own, and for a value naming no
 * CLI.
 */
export function turnMemberOf(payload: unknown): TurnMember | null {
  const record = asRecord(payload);
  const kind = AgentKindSchema.safeParse(record?.['agentKind']);
  if (!kind.success) {
    return null;
  }
  const model = asString(record?.['agentModel']);
  return {
    agentKind: kind.data,
    model: model === null || model === '' ? null : model,
  };
}

/** The CLI {@link turnMemberOf} names, or null. */
export function turnAgentKindOf(payload: unknown): AgentKind | null {
  return turnMemberOf(payload)?.agentKind ?? null;
}

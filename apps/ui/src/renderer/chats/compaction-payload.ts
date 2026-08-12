/**
 * What a `system` row's `compaction` key says about the compaction whose summary
 * the row carries.
 *
 * TWIN PARSER: `apps/daemon/src/v1/agents/services/chat.service.ts` stamps this
 * key onto a CLI-authored notice when the compaction boundary that preceded it
 * reported token figures. An item payload is `z.unknown()` on the wire BY DESIGN
 * — every item kind carries a different shape — so no generated type reaches the
 * renderer and the two sides are independent readings of one shape. Rename the
 * key there and this file must change with it.
 *
 * A plain `.ts` module rather than a helper inside the row component, for the
 * reason `system-payload.ts` is one: a pure payload reader parked in a `.tsx`
 * previously closed a real value-import cycle in this directory.
 */

import { formatTokens } from './agent-activity';

/** Presence of this marker is what says the row IS a compaction summary. */
export interface CompactionFacts {
  /** Context tokens before the compaction, or null if the CLI did not say. */
  preTokens: number | null;
  /** Context tokens after it, or null. Claude reports this less often than pre. */
  postTokens: number | null;
}

/**
 * Read the compaction marker off a `system` item's payload, or null when the row
 * is an ordinary relayed notice.
 *
 * The marker — not the message TEXT — is what identifies a compaction summary. A
 * CLI that reworded its "This session is being continued…" preamble would
 * silently stop being recognised by a pattern match, and the daemon refuses to
 * pattern-match it for exactly that reason.
 */
export function compactionFacts(payload: unknown): CompactionFacts | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const value = (payload as { compaction?: unknown }).compaction;
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const record = value as { preTokens?: unknown; postTokens?: unknown };
  return {
    preTokens: positive(record.preTokens),
    postTokens: positive(record.postTokens),
  };
}

/** A positive token count, else null — a zero window is nothing worth showing. */
function positive(value: unknown): number | null {
  return typeof value === 'number' && value > 0 ? value : null;
}

/**
 * The one line the collapsed row shows about what the compaction did, or
 * undefined when the CLI reported no figures at all.
 *
 * Three readings, because the CLI does not always report both halves — claude
 * 2.1.228 sends `pre_tokens` on every boundary and `post_tokens` only sometimes.
 * Each says only what is known: never a subtraction across a missing operand, and
 * never a fabricated "after" figure, which would be the one number a reader would
 * actually act on.
 */
export function compactionDetail(facts: CompactionFacts): string | undefined {
  const { preTokens, postTokens } = facts;
  if (preTokens !== null && postTokens !== null) {
    return `${formatTokens(preTokens)} → ${formatTokens(postTokens)} tokens`;
  }
  if (preTokens !== null) {
    return `${formatTokens(preTokens)} tokens summarised`;
  }
  if (postTokens !== null) {
    return `${formatTokens(postTokens)} tokens after compacting`;
  }
  return undefined;
}

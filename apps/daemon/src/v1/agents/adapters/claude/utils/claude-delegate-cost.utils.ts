import { asNumber, asRecord } from '../../../utils/json-util';
import {
  canonicalClaudeModel,
  CLAUDE_CACHE_READ_MULTIPLIER,
  CLAUDE_CACHE_WRITE_MULTIPLIER,
  CLAUDE_LIST_PRICES,
} from '../claude-pricing.const';

/**
 * One piece of work's token spend, broken down the way BILLING breaks it down.
 *
 * Four figures rather than a total, and that is the whole reason this exists:
 * the four are priced at rates that differ by a factor of 12.5 (a cache write
 * bills 1.25x input, a cache read 0.1x), so a delegate's total token count says
 * almost nothing about what it cost. Measured on the 2.1.251 probe: a delegate
 * that was 99.98% cache-write cost roughly twice what its share of the turn's
 * blended per-token rate would have claimed.
 */
export interface ClaudeTokenSpend {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

/** A delegate's spend, plus the model that has to price it. */
export interface ClaudeDelegateSpend extends ClaudeTokenSpend {
  /** The CLI's `resolvedModel`, variant suffix and all. */
  model: string | null;
}

/**
 * What one delegate cost, derived from its tokens and CALIBRATED against the
 * CLI's own figure for the turn that ran it.
 *
 * The problem this solves: claude prices a turn and never a delegate, and the
 * turn's price cannot be split by token share (see {@link ClaudeTokenSpend}).
 * Pricing the delegate's own breakdown from a list table gets close but not
 * right, because a model's rate DOUBLES above the 200k context boundary and
 * nothing on the wire says how much of a turn fell on either side. Measured on
 * the 2.1.251 probe: the turn's `modelUsage` priced at Opus 5 list came to
 * $0.3605 where the CLI reported $0.4439 — an implied 1.23x, i.e. a turn billed
 * partly at each tier.
 *
 * So the factor is not assumed, it is SOLVED, per model, from the same
 * `result` line: whatever the CLI says a model's tokens cost, divided by what
 * this app's table says they cost. Applying that to the delegate's own
 * breakdown priced the probe's delegate at $0.226, inside the $0.18-$0.37 band
 * its cache-write-heavy mix has to fall in, where a proportional split of the
 * turn said $0.117.
 *
 * Two properties worth naming, because they are why a price table is tolerable
 * here at all. The table's error is MEASURED every turn rather than assumed
 * away, so a uniformly stale table self-corrects — the factor drifts by exactly
 * the amount the table is wrong by. And a model the table has never heard of
 * prices to null, which reaches the reader as tokens with no dollars rather
 * than as a wrong number.
 *
 * Scope-safe whether `modelUsage` is the turn's or the session's running total
 * (`total_cost_usd` is known to be the latter — see
 * {@link ClaudeSessionCostLedger}): the numerator and denominator are read from
 * the SAME entry, so the ratio means the same thing either way.
 */
export class ClaudeDelegateCostLedger {
  /** Insertion-ordered — see {@link remember}. Keyed by launching tool call. */
  private readonly pending = new Map<string, ClaudeDelegateSpend>();

  /**
   * Hold one delegate's breakdown until the turn that ran it reports its price.
   *
   * The order is fixed and is why this has to wait at all: a delegate's
   * `tool_use_result` arrives while the turn is still working, and the `result`
   * line carrying the only real money figure comes last.
   */
  record(toolCallId: string, spend: ClaudeDelegateSpend): void {
    this.pending.delete(toolCallId);
    this.pending.set(toolCallId, spend);
    while (this.pending.size > MAX_PENDING_DELEGATES) {
      const oldest = this.pending.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.pending.delete(oldest.value);
    }
  }

  /**
   * Price every delegate this turn held, off the turn's own `result` line.
   *
   * Empties the pending set whether or not a figure came out of it: a `result`
   * ends the turn, so a delegate left unpriced here has no later line to be
   * priced by, and keeping it would attach this turn's delegates to the next
   * turn's calibration.
   */
  settle(root: Record<string, unknown>): { id: string; costUsd: number }[] {
    const delegates = [...this.pending.entries()];
    this.pending.clear();
    if (delegates.length === 0) {
      return [];
    }
    const calibration = readCalibration(root);
    const priced: { id: string; costUsd: number }[] = [];
    for (const [id, spend] of delegates) {
      const factor =
        spend.model === null
          ? null
          : (calibration.byModel.get(canonicalClaudeModel(spend.model)) ??
            calibration.overall);
      const list =
        spend.model === null ? null : listCostUsd(spend.model, spend);
      if (factor === null || list === null) {
        continue;
      }
      priced.push({ id, costUsd: list * factor });
    }
    return priced;
  }
}

/**
 * How many delegates' breakdowns to hold. One small record each, and sized to
 * never drop a delegate still waiting for its turn to end rather than to save
 * memory — a turn that fans out to dozens is the case this feature is for.
 *
 * It is a cap and not a leak-fix: `settle` empties the map on every `result`.
 * This only bounds a CLI that streams delegate results and then never reports
 * a turn end at all.
 */
const MAX_PENDING_DELEGATES = 256;

/**
 * The band a solved calibration factor has to fall in to be believed.
 *
 * The real factor is bounded by construction: 1.0 when every token billed at
 * the standard tier, 2.0 when every one billed at the long-context tier, and
 * between the two for the mixes that actually occur. The band is widened well
 * past that so a table one price revision out of date still self-corrects
 * instead of going dark, while a factor outside it — this app pricing a model
 * as the wrong family entirely — is treated as a table too wrong to correct
 * from, and the delegate simply shows no dollars.
 */
const MIN_CALIBRATION = 0.5;
const MAX_CALIBRATION = 4;

/**
 * What the CLI charged for a model's tokens over what this app's table says
 * they cost — per model, and pooled across all of them as a fallback for a
 * delegate that ran on a model the turn's own roll-up does not name.
 */
function readCalibration(root: Record<string, unknown>): {
  byModel: Map<string, number>;
  overall: number | null;
} {
  const modelUsage = asRecord(root.modelUsage);
  const byModel = new Map<string, number>();
  if (!modelUsage) {
    return { byModel, overall: null };
  }
  let chargedTotal = 0;
  let listTotal = 0;
  for (const [id, value] of Object.entries(modelUsage)) {
    const entry = asRecord(value);
    const charged = entry ? asNumber(entry.costUSD) : null;
    if (!entry || charged === null) {
      continue;
    }
    const list = listCostUsd(id, {
      inputTokens: asNumber(entry.inputTokens),
      outputTokens: asNumber(entry.outputTokens),
      cacheReadTokens: asNumber(entry.cacheReadInputTokens),
      cacheCreationTokens: asNumber(entry.cacheCreationInputTokens),
    });
    if (list === null || list <= 0) {
      continue;
    }
    chargedTotal += charged;
    listTotal += list;
    const factor = charged / list;
    if (inBand(factor)) {
      byModel.set(canonicalClaudeModel(id), factor);
    }
  }
  const overall = listTotal > 0 ? chargedTotal / listTotal : null;
  return {
    byModel,
    overall: overall !== null && inBand(overall) ? overall : null,
  };
}

function inBand(factor: number): boolean {
  return (
    Number.isFinite(factor) &&
    factor >= MIN_CALIBRATION &&
    factor <= MAX_CALIBRATION
  );
}

/**
 * A token breakdown at LIST price, before calibration — null for a model this
 * build has no price for, which is the whole of how an unknown model degrades
 * to "tokens, no dollars".
 *
 * An absent figure counts as zero rather than voiding the sum: the four are
 * independent, and a build that reports three of them has still measured most
 * of the bill. A breakdown that is entirely absent yields 0 and is refused by
 * the callers, which both require a positive figure.
 */
export function listCostUsd(
  model: string,
  spend: ClaudeTokenSpend,
): number | null {
  const price = CLAUDE_LIST_PRICES.get(canonicalClaudeModel(model));
  if (price === undefined) {
    return null;
  }
  const perMillion =
    (spend.inputTokens ?? 0) * price.input +
    (spend.outputTokens ?? 0) * price.output +
    (spend.cacheCreationTokens ?? 0) *
      price.input *
      CLAUDE_CACHE_WRITE_MULTIPLIER +
    (spend.cacheReadTokens ?? 0) * price.input * CLAUDE_CACHE_READ_MULTIPLIER;
  return perMillion / 1_000_000;
}

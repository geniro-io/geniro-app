import {
  asArray,
  asNumber,
  asRecord,
  asString,
} from '../../../utils/json-util';
import type { AgentUsage } from '../../adapter.types';

/**
 * The running totals claude's own cost ledger reports, per CLI SESSION.
 *
 * `result.total_cost_usd` and `result.duration_api_ms` are NOT this turn's
 * figures — they are the session's, and they keep climbing for as long as the
 * process lives. Probe-verified on 2.1.233, two turns on one stdin session:
 *
 *   turn 1  total_cost_usd 0.1166802   duration_api_ms 2219
 *   turn 2  total_cost_usd 0.1384620   duration_api_ms 4159
 *
 * Turn 2 cost $0.0218 and spent 1940ms in the API; the line says $0.1385 and
 * 4159ms. The binary says the same thing outright — both fields are read off
 * `pr.costLedger` (`totalCostUSD()` / `totalAPIDuration()`), one ledger per
 * session (`costLedger: e.kind === "fork" ? e.root.costLedger : new ecs`).
 *
 * Recording the running total as the turn's own is how a chat that cost $141
 * came to be billed at $1,356 on the Stats page: the ledger SUMS what it is
 * given, so a climbing ladder is added to itself once per rung. This class is
 * what turns the ladder back into steps.
 *
 * **Keyed by claude's own `session_id`, which is what makes it safe on a shared
 * adapter.** One adapter instance serves N concurrent turns under graph
 * fan-out, but a session id belongs to exactly one CLI process, and a run's
 * turns are serialized behind RUN_BUSY — so two turns can never be reading and
 * writing the same entry.
 *
 * Note what is deliberately NOT here: `usage.*` and `duration_ms` are already
 * per-turn on the wire (same probe — `cache_creation_input_tokens` fell 18,212
 * → 1,485, and `duration_ms` 2,395 → 2,093), so subtracting them would turn
 * correct figures into nonsense.
 */
export class ClaudeSessionCostLedger {
  /** Insertion-ordered, so the oldest entry is the first key — see `remember`. */
  private readonly totals = new Map<string, SessionTotals>();

  /**
   * This turn's own cost and API time, from the session totals the line
   * carries.
   *
   * A session id we have not seen contributes its full total, which is right
   * for a first turn and is also the only honest answer for a session this
   * process did not watch from the start (an adopted daemon, a restarted UI).
   *
   * A total that went DOWN means a new ledger behind a reused id, so the figure
   * is taken whole rather than clamped to zero — the alternative silently drops
   * a real turn's spend.
   */
  perTurn(
    sessionId: string | null,
    cumulative: SessionTotals,
  ): { costUsd: number | null; apiMs: number | null } {
    if (sessionId === null) {
      // Nothing to key on. Reporting the running total would be the very bug
      // this class exists to stop, and no `result` line has been observed
      // without the field — so the honest answer is "not measured".
      return { costUsd: null, apiMs: null };
    }
    const previous = this.totals.get(sessionId);
    this.remember(sessionId, cumulative);
    return {
      costUsd: step(previous?.costUsd ?? null, cumulative.costUsd),
      apiMs: step(previous?.apiMs ?? null, cumulative.apiMs),
    };
  }

  /** Drop a finished session's entry. */
  forget(sessionId: string): void {
    this.totals.delete(sessionId);
  }

  /**
   * Record the new high-water mark, evicting the oldest entry past the cap.
   *
   * The cap is the whole reason this is not a plain Map: a long-lived daemon
   * sees a new session id per chat, and `forget` is best-effort — a SIGKILLed
   * CLI never reports its own end. Losing the oldest entry costs one turn's
   * delta on a session nobody has touched in hundreds of chats.
   */
  private remember(sessionId: string, totals: SessionTotals): void {
    this.totals.delete(sessionId);
    this.totals.set(sessionId, totals);
    while (this.totals.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.totals.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.totals.delete(oldest.value);
    }
  }
}

/** One session's running totals, as the last `result` line stated them. */
interface SessionTotals {
  costUsd: number | null;
  apiMs: number | null;
}

/**
 * How many sessions' running totals to keep. Two numbers per entry, so this is
 * kilobytes at the cap — sized to never evict an entry still in use rather than
 * to save memory.
 */
const MAX_TRACKED_SESSIONS = 512;

/**
 * One rung of the ladder: what this turn added to a session total.
 *
 * Null in either position yields null rather than a guess — an unmeasured
 * figure must not become a measured zero, which is the same rule the whole
 * usage path follows.
 */
function step(previous: number | null, current: number | null): number | null {
  if (current === null) {
    return null;
  }
  if (previous === null || current < previous) {
    return current;
  }
  return current - previous;
}

/**
 * Read one claude `result` line's token accounting.
 *
 * The subtlety this file exists for: `result.usage` is the turn's CUMULATIVE
 * total across every API request the turn made, NOT the conversation's size.
 * A turn that calls eight tools bills eight prompts, each one re-reading the
 * whole (cached) conversation — so summing that usage reports several times
 * the context that ever existed. Probed live on claude 2.1.220:
 *
 *   result.usage        input 12 · cache_creation 20_281 · cache_read 171_614  → 191_907
 *   last API request    input  2 · cache_creation    158 · cache_read  28_123  →  28_283
 *
 * The 191,907 figure is what put "ctx 2.8M / 200k" on a chat whose context had
 * never passed 30k. So context comes from `usage.iterations` — the per-request
 * breakdown, whose LAST entry is the final request's prompt — and never from
 * the roll-up. A CLI build that reports no iterations yields `null`: an unknown
 * context reads as "not shown", where the roll-up would read as a wrong number.
 *
 * `modelUsage` additionally names each model's real window
 * (`claude-opus-5[1m]` → 1_000_000), which is the only reason the ring can stop
 * measuring every model against an assumed 200k.
 */
export function readClaudeUsage(
  root: Record<string, unknown>,
  ledger: ClaudeSessionCostLedger,
): AgentUsage {
  const usage = asRecord(root.usage);
  const iterations = usage ? asArray(usage.iterations) : [];
  const lastRequest = asRecord(iterations[iterations.length - 1]);
  const context = readContextWindow(root);
  // The two SESSION-scoped fields, turned back into this turn's own. Required
  // rather than optional: an overload that silently reported the running total
  // when the ledger was left out is exactly the defect, and it would be
  // invisible in every spec that did not pass one.
  const step = ledger.perTurn(asString(root.session_id), {
    costUsd: asNumber(root.total_cost_usd),
    apiMs: asNumber(root.duration_api_ms),
  });
  return {
    // Cumulative by nature and labelled as such — the turn's billed input.
    inputTokens: usage ? asNumber(usage.input_tokens) : null,
    outputTokens: usage ? asNumber(usage.output_tokens) : null,
    // The other two thirds of the same roll-up, and what makes it explicable:
    // a turn billing 2 fresh input tokens beside 17,950 cache reads and 19,473
    // cache writes did not send almost nothing, which is what `input_tokens`
    // alone says (probed on 2.1.232, a one-line "say hi" turn).
    cacheReadTokens: usage ? asNumber(usage.cache_read_input_tokens) : null,
    cacheCreationTokens: usage
      ? asNumber(usage.cache_creation_input_tokens)
      : null,
    thinkingTokens: readThinkingTokens(usage),
    contextTokens: promptSideTokens(lastRequest),
    contextWindowTokens: context.window,
    contextModel: context.model,
    // THIS TURN's spend, not the session's running total — see
    // {@link ClaudeSessionCostLedger} for the probe and for what summing the
    // total instead did to the Stats page.
    costUsd: step.costUsd,
    // The CLI's OWN clock for the turn, which is the number worth having: it
    // starts when the CLI begins working and so counts neither geniro's
    // MCP-readiness hold nor a stretch parked on an approval card. Probed on
    // 2.1.x (2026-08-14): `duration_ms` 7618 / `duration_api_ms` 7176 on a
    // one-tool turn. Both were being dropped, which is why a finished turn
    // could show its cost and never its time.
    //
    // `duration_ms` is genuinely per-turn and is read straight; `duration_api_ms`
    // is the session roll-up and goes through the ledger with the cost.
    durationMs: asNumber(root.duration_ms),
    apiMs: step.apiMs,
  };
}

/**
 * Of the turn's output, how much was thinking — `usage.output_tokens_details.
 * thinking_tokens` (probed on 2.1.232; `0` on a turn that did not think).
 *
 * Absent means the build does not break output down, which is not the same as
 * a turn that thought nothing — so a missing block reads null and the readout
 * withholds the split rather than reporting a zero nobody stated.
 */
function readThinkingTokens(
  usage: Record<string, unknown> | null,
): number | null {
  const details = usage ? asRecord(usage.output_tokens_details) : null;
  return details ? asNumber(details.thinking_tokens) : null;
}

/**
 * How full the window is as of ONE `assistant` line — its `message.usage`.
 *
 * The live counterpart of {@link readClaudeUsage}'s `contextTokens`, and the
 * same arithmetic: an `assistant` line reports the usage of the single request
 * that produced it, which is exactly the per-request shape the roll-up must
 * never be confused with. PROBE-VERIFIED on claude 2.1.220 — every `assistant`
 * line carried `input_tokens` + `cache_creation_input_tokens` +
 * `cache_read_input_tokens`, while `contextWindow` appeared ONLY on `result`.
 *
 * Null when the line carries no usage, so a CLI build that omits it degrades
 * to "the meter waits for the turn to finish", never to a wrong number.
 */
export function readClaudeAssistantContext(
  message: Record<string, unknown>,
): number | null {
  return promptSideTokens(asRecord(message.usage));
}

/**
 * Everything one request put on the prompt side of the window: fresh input,
 * newly cached input, and cache reads. `input_tokens` alone excludes all cache
 * traffic, which on a resumed conversation is nearly the entire context.
 */
function promptSideTokens(
  request: Record<string, unknown> | null,
): number | null {
  if (!request) {
    return null;
  }
  const parts = [
    asNumber(request.input_tokens),
    asNumber(request.cache_creation_input_tokens),
    asNumber(request.cache_read_input_tokens),
  ].filter((part): part is number => part !== null);
  return parts.length > 0 ? parts.reduce((sum, part) => sum + part, 0) : null;
}

/**
 * The window of the model that did the turn's work.
 *
 * `modelUsage` is keyed by model id and a turn can touch more than one (a small
 * model runs side errands), so the entry that spent the most prompt tokens is
 * the one the context figure above belongs to — matching by name would mean
 * this file knowing model ids, which is exactly what asking the CLI avoids.
 */
function readContextWindow(root: Record<string, unknown>): {
  window: number | null;
  model: string | null;
} {
  const modelUsage = asRecord(root.modelUsage);
  if (!modelUsage) {
    return { window: null, model: null };
  }
  let window: number | null = null;
  let model: string | null = null;
  let best = -1;
  for (const [id, value] of Object.entries(modelUsage)) {
    const entry = asRecord(value);
    const contextWindow = entry ? asNumber(entry.contextWindow) : null;
    if (!entry || contextWindow === null) {
      continue;
    }
    const spent =
      (asNumber(entry.inputTokens) ?? 0) +
      (asNumber(entry.cacheCreationInputTokens) ?? 0) +
      (asNumber(entry.cacheReadInputTokens) ?? 0);
    if (spent > best) {
      best = spent;
      window = contextWindow;
      // The KEY, which is the id `system/init` announces
      // (`claude-opus-5[1m]`) — not the entry's `canonicalModel`, which drops
      // the variant and so cannot tell a 1M model from its 200k sibling.
      model = id;
    }
  }
  return { window, model };
}

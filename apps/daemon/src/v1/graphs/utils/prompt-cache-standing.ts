import { contextPercent } from '../../agents/utils/auto-compact';
import { asNumber, asRecord } from '../../agents/utils/json-util';
import { positive } from '../../agents/utils/positive-figure';

/**
 * Past this share of its window, a callee conversation whose prompt cache has
 * lapsed costs more to resume than to replace: resuming re-writes the whole
 * conversation to the cache at full price, while a fresh instance starts from
 * the brief alone.
 *
 * TWIN: `apps/ui/src/renderer/chats/prompt-cache-badge.tsx` draws the same
 * rule for the user; a change here is mirrored there.
 */
export const COLD_RESUME_CONTEXT_PERCENT = 50;
/**
 * Said wherever a caller chooses between resuming and starting over. It states
 * the costs and the refusal, and recommends neither: windows differ per model,
 * so the caller weighs the figures `list_agent_threads` reports.
 */
export const COLD_RESUME_RULE = `Continuing a conversation (call_agent with thread) keeps the callee's full memory, and every step of its turn re-reads that whole context at the cache-read price; once its prompt cache has EXPIRED, the turn first re-writes all of it to the cache at full price. A new instance (call_agent without thread) starts from your brief alone, so the brief must carry everything it needs from the old conversation. call_agent refuses to continue a conversation whose cache has EXPIRED and whose context is over ${COLD_RESUME_CONTEXT_PERCENT}% full (CACHE_EXPIRED), unless you pass resume_cold.`;

/**
 * What one callee conversation last reported about itself — read off its
 * newest settled call. Every figure is null when nothing measured it: a CLI
 * that reports no cache lifetime (cursor, codex) has no expiry, and that is
 * "unknown", never "expired".
 */
export interface ConversationCacheFacts {
  /** When the conversation's newest turn ended, epoch ms. */
  endedAt: number | null;
  /** The prompt-cache lifetime the CLI reported for it. */
  promptCacheTtlMs: number | null;
  contextTokens: number | null;
  contextWindowTokens: number | null;
}

export type PromptCacheStanding =
  | { state: 'warm'; expiresAt: number }
  | { state: 'expired'; expiredAt: number }
  | { state: 'unknown' };

/** Where the conversation's prompt cache stands at `now`. */
export function promptCacheStanding(
  facts: ConversationCacheFacts,
  now: number,
): PromptCacheStanding {
  const expiresAt = expiryOf(facts.endedAt, facts.promptCacheTtlMs);
  if (expiresAt === null) {
    return { state: 'unknown' };
  }
  return expiresAt > now
    ? { state: 'warm', expiresAt }
    : { state: 'expired', expiredAt: expiresAt };
}

/**
 * A percentage as a caller or the user reads it: to a tenth, but never rounded
 * DOWN onto the threshold — a window just over it must not read as at it,
 * beside a verdict that says it is over. TWIN of the badge's tooltip.
 */
export function statedPercent(percent: number): number {
  const tenths = Math.round(percent * 10) / 10;
  return percent > COLD_RESUME_CONTEXT_PERCENT &&
    tenths <= COLD_RESUME_CONTEXT_PERCENT
    ? Math.ceil(percent * 10) / 10
    : tenths;
}

/** How full the conversation's window was when it last reported, or null. */
export function conversationContextPercent(
  facts: ConversationCacheFacts,
): number | null {
  return contextPercent({
    tokens: facts.contextTokens,
    window: facts.contextWindowTokens,
  });
}

/**
 * Whether resuming this conversation would re-bill a large context uncached —
 * its cache has lapsed AND its window is past {@link COLD_RESUME_CONTEXT_PERCENT}.
 * An unknown expiry or an unmeasured window is never cold-and-large: the rule
 * acts only on what was measured.
 */
export function isColdAndLarge(
  facts: ConversationCacheFacts,
  now: number,
): boolean {
  const percent = conversationContextPercent(facts);
  return (
    promptCacheStanding(facts, now).state === 'expired' &&
    percent !== null &&
    percent > COLD_RESUME_CONTEXT_PERCENT
  );
}

/**
 * One conversation's facts from its calls' records, newest call LAST. The
 * timing and the window come from the newest call; the lifetime falls back to
 * the newest one any call stated, since a turn served wholly from cache writes
 * nothing and so reports no lifetime of its own.
 */
export function conversationFacts(
  calls: readonly ConversationCacheFacts[],
): ConversationCacheFacts {
  const newest = calls[calls.length - 1];
  if (newest === undefined) {
    return {
      endedAt: null,
      promptCacheTtlMs: null,
      contextTokens: null,
      contextWindowTokens: null,
    };
  }
  let ttl: number | null = null;
  for (const call of calls) {
    ttl = call.promptCacheTtlMs ?? ttl;
  }
  return { ...newest, promptCacheTtlMs: newest.promptCacheTtlMs ?? ttl };
}

/**
 * One conversation's cache clock as its usage rows are folded in seq order:
 * when its newest turn ended, and the lifetime last stated for it.
 */
export interface TurnCacheClock {
  endedAt: number | null;
  promptCacheTtlMs: number | null;
}

/** Fold one usage row (its time and payload) into a conversation's clock. */
export function advanceCacheClock(
  clock: TurnCacheClock | undefined,
  createdAt: Date | undefined,
  payload: Record<string, unknown> | null,
  /**
   * The lifetime the same agent last stated on ANY of its turns — what a turn
   * served wholly from cache, which writes nothing and so states none, still
   * runs under.
   */
  fallbackTtlMs: number | null = null,
): TurnCacheClock {
  const at = createdAt?.getTime();
  const stated = statedTtlOf(payload);
  return {
    endedAt:
      at !== undefined && Number.isFinite(at) ? at : (clock?.endedAt ?? null),
    promptCacheTtlMs: stated ?? clock?.promptCacheTtlMs ?? fallbackTtlMs,
  };
}

/** The prompt-cache lifetime one usage row states, or null when it states none. */
export function statedTtlOf(
  payload: Record<string, unknown> | null,
): number | null {
  const ttl = asNumber(asRecord(payload?.usage)?.promptCacheTtlMs);
  return positive(ttl) ? ttl : null;
}

/** When a cache written at `endedAt` with lifetime `ttlMs` lapses, or null. */
function expiryOf(endedAt: number | null, ttlMs: number | null): number | null {
  return endedAt !== null && Number.isFinite(endedAt) && positive(ttlMs)
    ? endedAt + ttlMs
    : null;
}

/** A clock's expiry as the wire states it (ISO), or null when unknown. */
export function cacheExpiryOf(
  clock: TurnCacheClock | undefined,
): string | null {
  const expiresAt =
    clock === undefined
      ? null
      : expiryOf(clock.endedAt, clock.promptCacheTtlMs);
  return expiresAt === null ? null : new Date(expiresAt).toISOString();
}

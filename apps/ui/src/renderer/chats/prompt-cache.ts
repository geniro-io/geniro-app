/**
 * Where a chat's PROMPT CACHE stands, for the line under the composer.
 *
 * The provider keeps a conversation's prompt cached for a fixed time after
 * each request (claude: one hour on a subscription, five minutes on an API
 * key). Inside that window the next message is billed as a cache READ; once it
 * lapses, the next message re-writes the WHOLE conversation to the cache at
 * full price — the first turn back from a long break is the most expensive one
 * in the thread, and nothing on screen said so. Claude Code's own answer is to
 * compact while idle (interactive sessions only — geniro's `-p` sessions never
 * arm it); this one is to tell the user before they press Send.
 *
 * The expiry is the DAEMON's (`RunDto.promptCacheExpiresAt`: the end of the
 * newest turn plus the lifetime its CLI reported), so this only reads a clock.
 */

/**
 * How long before the cache lapses the composer starts counting down. Short
 * enough that a five-minute cache is not under a countdown for most of its
 * life, long enough to finish a sentence and send it.
 */
export const PROMPT_CACHE_EXPIRING_MS = 2 * 60_000;

export type PromptCacheState =
  | { kind: 'expiring'; remainingMs: number }
  | { kind: 'expired'; sinceMs: number };

/**
 * The cache's state at `now`, or null when there is nothing to say — no
 * expiry known (a CLI that reports no cache, a workflow run), or comfortably
 * inside the window.
 */
export function promptCacheState(
  expiresAt: string | null | undefined,
  now: number,
): PromptCacheState | null {
  if (typeof expiresAt !== 'string') {
    return null;
  }
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) {
    return null;
  }
  const remaining = at - now;
  if (remaining <= 0) {
    return { kind: 'expired', sinceMs: -remaining };
  }
  if (remaining <= PROMPT_CACHE_EXPIRING_MS) {
    return { kind: 'expiring', remainingMs: remaining };
  }
  return null;
}

/**
 * How long until the state can next CHANGE from nothing-to-say into a
 * countdown — what lets the notice sleep through an hour-long cache instead of
 * re-rendering every second. Null once a state is showing (it then ticks) or
 * when there is no expiry to wait for.
 */
export function msUntilPromptCacheNotice(
  expiresAt: string | null | undefined,
  now: number,
): number | null {
  if (typeof expiresAt !== 'string') {
    return null;
  }
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) {
    return null;
  }
  const until = at - PROMPT_CACHE_EXPIRING_MS - now;
  return until > 0 ? until : null;
}

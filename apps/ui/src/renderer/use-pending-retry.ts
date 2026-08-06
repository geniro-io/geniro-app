import { useEffect, useState } from 'react';

/**
 * How long to wait before asking again for a listing the daemon reported as
 * still being read.
 *
 * The daemon answers a cold MCP read immediately with `pending` and finishes
 * the dial behind it — that dial STARTS the user's own MCP servers, so it is
 * measured in seconds (6.7s here against nine of them) against a 400ms
 * first-paint budget. Asking again on this cadence is what turns the wait into
 * rows appearing rather than a spinner that ends in an empty panel.
 */
export const PENDING_RETRY_MS = 1000;

/**
 * Poll while the daemon says a read is still running.
 *
 * SHARED by both MCP hooks — the chat panel's `useAgentMcp` and the graph
 * inspector's `useNodeMcp` — because they were each carrying their own copy of
 * this cadence and this effect, and the copies are precisely how one defect
 * came to exist twice: both keyed the retry on a derived BOOLEAN, and a boolean
 * that is true after the first pending answer is still true after the second,
 * so React skipped the effect and no second timer was ever armed. With a cold
 * dial an order of magnitude longer than the budget, pending-then-pending is
 * the ordinary case — so both panels would spin forever, one ask short, in
 * exactly the situation the non-blocking read exists for.
 *
 * The fix lives here once: the caller passes the ANSWER it last received, and
 * the effect keys on that identity. A caller storing a fresh object per read
 * therefore re-arms exactly once per answer, however many of them say pending.
 *
 * @param answer   The last answer received, whatever shape the caller stores.
 *                 Only its IDENTITY is used, never its contents — pass the
 *                 state object the caller replaces on each read.
 * @param waiting  Whether that answer says a read is still running.
 * @returns A token that increments once per due poll. Put it in the read
 *          effect's dependency list; it is a PLAIN re-read, so the caller must
 *          not let it bypass the daemon's cache — the dial being waited on is
 *          already running, and a second one would relaunch the user's servers.
 */
export function usePendingRetry(answer: unknown, waiting: boolean): number {
  const [token, setToken] = useState(0);

  useEffect(() => {
    if (!waiting) {
      return;
    }
    const timer = setTimeout(() => setToken((n) => n + 1), PENDING_RETRY_MS);
    return () => clearTimeout(timer);
  }, [answer, waiting]);

  return token;
}

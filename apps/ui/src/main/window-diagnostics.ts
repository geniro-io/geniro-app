import type { DaemonHandle } from '../shared/contracts';

/**
 * What the MAIN process saw happen to a window, written into the daemon's log.
 *
 * The gap this fills was found the hard way. A user's window reopened showing a
 * document that was not the app — raw bytes in the browser's default serif,
 * no stylesheet, no React — and there was nothing anywhere to say what it had
 * loaded. Not by accident: the `ui` channel only ever carries what
 * `report-ui-errors.ts` catches, which is `window.onerror` and unhandled
 * rejections FROM THE RENDERER, and a window that never ran the renderer
 * cannot report through it. The main process, which is the one party that can
 * see a load commit at all, had no path into the log whatsoever — so across
 * every log file on that machine the `ui` channel held zero entries, on a day
 * that included exactly the failure it exists for.
 *
 * Deliberately its OWN small module rather than a method on the supervisor: it
 * shares nothing with supervising a daemon except the address to post to, and
 * the pure predicates below are the part that has to be tested.
 */

/**
 * How long a report may take before it is abandoned.
 *
 * Short on purpose: this runs on the window's load path, and a diagnostic that
 * can hold a boot is worse than one that is occasionally missed.
 */
const REPORT_TIMEOUT_MS = 2_000;

/**
 * Electron's code for a load the browser CANCELLED rather than failed.
 *
 * Emitted by ordinary things — a redirect, a reload issued while the previous
 * one is in flight, the dev server's HMR — so treating it as a failure would
 * report a working app as broken and, worse, trigger a recovery reload against
 * a load that was already being replaced.
 */
export const ERR_ABORTED = -3;

/** One `did-fail-load`, as Electron reports it. */
export interface LoadFailure {
  errorCode: number;
  errorDescription: string;
  url: string;
  /** False for a sub-resource — only the top document is worth acting on. */
  isMainFrame: boolean;
}

/** Whether this `did-fail-load` is a real failure of the app's own document. */
export function isRealLoadFailure(failure: LoadFailure): boolean {
  return failure.isMainFrame && failure.errorCode !== ERR_ABORTED;
}

/**
 * The sentence a reader needs: the code, Electron's own words for it, and the
 * URL it was trying to reach. All three, because the code alone is a number
 * nobody remembers and the description alone does not say what failed to load.
 */
export function describeLoadFailure(failure: LoadFailure): string {
  return `the renderer failed to load ${failure.url}: ${failure.errorDescription} (${failure.errorCode})`;
}

/**
 * Post one line to the daemon's debug log as the `ui` channel.
 *
 * Fire-and-forget and swallowing every failure, on the same rule
 * `report-ui-errors.ts` follows: this runs on error paths, so a rejection here
 * would be a second failure raised by the thing reporting the first. A null
 * handle is the ordinary case rather than an error — the window is opened
 * BEFORE the daemon is ensured, so the earliest load events genuinely have
 * nowhere to go yet.
 */
/** One report that had no daemon to go to yet — see {@link flushMainLogs}. */
interface PendingReport {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context: Record<string, string>;
}

/**
 * Reports raised before the daemon existed.
 *
 * NOT an optimization — without it this whole mechanism misses the case it was
 * written for. The window is created BEFORE `ensureDaemon()` on purpose (first
 * paint overlaps the spawn), so a load that fails or commits in those first few
 * hundred milliseconds has nowhere to post: the very first window's line, which
 * is the one that says what the app opened with, would be the one always
 * dropped.
 *
 * Bounded, because a daemon that never starts must not grow this forever, and
 * OLDEST-first: the earliest lines are the ones describing how the launch went
 * wrong, which is what a later reader is looking for.
 */
const pending: PendingReport[] = [];
const MAX_PENDING = 50;

/** Hand the buffered reports to the daemon now that there is one. */
export async function flushMainLogs(
  handle: DaemonHandle | null,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const queued = pending.splice(0, pending.length);
  if (!handle) {
    return;
  }
  for (const report of queued) {
    await reportMainLog(
      handle,
      report.level,
      report.message,
      report.context,
      fetchImpl,
    );
  }
}

export async function reportMainLog(
  handle: DaemonHandle | null,
  /**
   * The daemon's own level vocabulary. Spelled here rather than imported: the
   * Electron side holds no daemon types (`shared/contracts.ts` is deliberately
   * free of them) and the generated client is the RENDERER's.
   */
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error',
  message: string,
  context: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!handle) {
    if (pending.length < MAX_PENDING) {
      pending.push({ level, message, context });
    }
    return;
  }
  try {
    await fetchImpl(
      `http://${handle.host}:${handle.port}/v1/diagnostics/ui-log`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${handle.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          level,
          message: message.slice(0, 8_000),
          // `from` on every line, because the channel already carries the
          // RENDERER's errors and a reader has to be able to tell which process
          // is talking — they see different halves of the same window.
          context: { ...context, from: 'main' },
        }),
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      },
    );
  } catch {
    // See the doc block: a diagnostic must never become the failure.
  }
}

/**
 * A page asking for a chunk of the build it was LOADED from, after the app was
 * rebuilt or updated underneath it — and the one reload that cures it.
 *
 * Every view but the chats is a lazy chunk named by its content hash, and a
 * phone keeps its tab open across the Mac's updates. Its next screen change
 * then asks the gateway for files that no longer exist: REPORTED as the
 * Graphs page on a phone reading "Importing a module script failed.". There
 * are three places such a failure can surface, and all three go through here
 * so they agree about whether a reload is already under way: the root
 * `ErrorBoundary` (a lazy view), the boot's own `import('./App')`, and vite's
 * `vite:preloadError` event, which every lazily imported module passes
 * through before anything renders.
 */

/**
 * How a chunk the server no longer has is worded: Chromium, Safari and
 * Firefox for the module itself, then vite's own sentence for the chunk's
 * STYLESHEET, which it preloads first — so on a stale page opening a view
 * that has CSS, this is the error that arrives, not the engine's.
 */
const STALE_BUNDLE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS for/i;

/** When, and from which page, this tab last reloaded for a stale bundle. */
const STALE_RELOAD_KEY = 'geniro.staleBundleReloadAt';

/**
 * A second stale-bundle failure this soon after a reload for one is not a
 * stale bundle — reloading again would only fail the same way, forever.
 */
const STALE_RELOAD_GUARD_MS = 30_000;

/** The DOM event vite dispatches when a lazily imported module fails. */
const VITE_PRELOAD_ERROR = 'vite:preloadError';

interface StaleReloadStamp {
  at: number;
  /** `performance.timeOrigin` of the page that asked — what tells "this page already asked" from "the page before this one did". */
  page: number;
}

function readStamp(raw: string | null): StaleReloadStamp | null {
  if (raw === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === 'object' &&
      value !== null &&
      'at' in value &&
      'page' in value &&
      typeof value.at === 'number' &&
      typeof value.page === 'number'
    ) {
      return { at: value.at, page: value.page };
    }
  } catch {
    // An unreadable stamp says nothing; it is overwritten below.
  }
  return null;
}

/** This page's identity for the stamp: when it started loading. */
function currentPage(): number {
  return typeof performance !== 'undefined' &&
    typeof performance.timeOrigin === 'number'
    ? performance.timeOrigin
    : 0;
}

/** Whether an error is a page asking for a chunk its build no longer serves. */
export function isStaleBundleError(error: unknown): boolean {
  return error instanceof Error && STALE_BUNDLE.test(error.message);
}

/**
 * Reload for the new bundle, ONCE — and say whether a reload is under way.
 *
 * True when this call started one or THIS page already did (a lazy view, the
 * boot and vite's event all report the same missing chunk, and only the first
 * should navigate). False when the page BEFORE this one reloaded for the same
 * reason moments ago, or when storage cannot remember that it did: a reload
 * nothing can bound is a loop.
 */
export function reloadForNewBundle(
  reload: () => void,
  page: number = currentPage(),
  now: number = Date.now(),
): boolean {
  let stamp: StaleReloadStamp | null;
  try {
    stamp = readStamp(sessionStorage.getItem(STALE_RELOAD_KEY));
  } catch {
    return false;
  }
  if (stamp !== null && stamp.page === page) {
    return true;
  }
  if (stamp !== null && now - stamp.at < STALE_RELOAD_GUARD_MS) {
    return false;
  }
  try {
    sessionStorage.setItem(
      STALE_RELOAD_KEY,
      JSON.stringify({ at: now, page } satisfies StaleReloadStamp),
    );
  } catch {
    return false;
  }
  reload();
  return true;
}

/**
 * Reload as soon as vite reports a lazily imported chunk the server no longer
 * has, before anything renders the failure. The event is NOT cancelled: the
 * import still rejects, so whatever awaited it (the `ErrorBoundary`) shows
 * "Loading the updated app…" — and, if the reload is refused, the error.
 * Returns the disposer.
 */
export function recoverFromStaleBundles(
  target: Window = window,
  reload: () => void = () => target.location.reload(),
): () => void {
  const onPreloadError = (event: Event): void => {
    const payload: unknown = Reflect.get(event, 'payload');
    if (isStaleBundleError(payload)) {
      reloadForNewBundle(reload);
    }
  };
  target.addEventListener(VITE_PRELOAD_ERROR, onPreloadError);
  return () => target.removeEventListener(VITE_PRELOAD_ERROR, onPreloadError);
}

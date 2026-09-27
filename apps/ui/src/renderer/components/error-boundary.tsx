import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from './ui/button';

/**
 * How the three engines word a lazily-loaded chunk that is no longer on the
 * server: Chromium, Safari and Firefox, in that order.
 */
const STALE_BUNDLE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

/** When this tab last reloaded for a stale bundle, in `sessionStorage`. */
const STALE_RELOAD_KEY = 'geniro.staleBundleReloadAt';

/**
 * A second stale-bundle failure this soon after reloading for one is not a
 * stale bundle — the reload would only fail the same way, forever.
 */
const STALE_RELOAD_GUARD_MS = 30_000;

/**
 * Whether a crash is a page asking for a chunk of the build it was LOADED
 * from, after the app was rebuilt or updated underneath it.
 *
 * Every view but the chats is a lazy chunk named by its content hash, and a
 * phone keeps its tab open across the Mac's updates — so the first screen
 * change after one asked for a file the gateway no longer serves, and landed
 * here as "Failed to fetch dynamically imported module". Found walking the
 * app on a phone; the cure is the reload this boundary already offered.
 */
export function isStaleBundleError(error: Error): boolean {
  return STALE_BUNDLE.test(error.message);
}

/**
 * Reload for a new bundle, ONCE: false when this tab already did so moments
 * ago, or when storage cannot remember that it did — a reload nothing can
 * bound is a loop.
 */
function reloadForNewBundle(reload: () => void): boolean {
  try {
    const last = Number(sessionStorage.getItem(STALE_RELOAD_KEY) ?? 0);
    if (Date.now() - last < STALE_RELOAD_GUARD_MS) {
      return false;
    }
    sessionStorage.setItem(STALE_RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  reload();
  return true;
}

/**
 * Root error boundary — a rendering crash anywhere below must surface the
 * error and a way back, never a silently blank window (React unmounts the
 * whole tree when an error escapes uncaught). Class component by necessity:
 * React has no hook equivalent of componentDidCatch.
 */
export class ErrorBoundary extends Component<
  {
    children: ReactNode;
    /** Test seam only — how a stale bundle is reloaded. */
    reload?: () => void;
  },
  { error: Error | null; reloadRefused: boolean }
> {
  state: { error: Error | null; reloadRefused: boolean } = {
    error: null,
    reloadRefused: false,
  };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('renderer crashed:', error, info.componentStack);
    if (
      isStaleBundleError(error) &&
      !reloadForNewBundle(this.props.reload ?? (() => window.location.reload()))
    ) {
      this.setState({ reloadRefused: true });
    }
  }

  render(): ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }
    if (isStaleBundleError(this.state.error) && !this.state.reloadRefused) {
      return (
        <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
          Loading the updated app…
        </div>
      );
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <p className="text-sm font-semibold">Something went wrong.</p>
        {/* `w-full min-w-0` is what makes the `overflow-auto` beside it MEAN
            anything. A `<pre>` does not wrap, so its min-content width is the
            whole line, and a flex item's automatic `min-width: auto` refuses
            to shrink below that — so the box grew past the padding and crossed
            the card's own border instead of ever scrolling. Reported against a
            384px catalog frame, and reachable in the app in any narrow window:
            this is the ROOT boundary, so it renders wherever the crash left
            the layout. `min-w-0` lifts that floor and `w-full` gives the box a
            width to be capped from, with `max-w-xl` still holding the wide
            case. */}
        <pre className="max-h-48 w-full min-w-0 max-w-xl overflow-auto rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          {this.state.error.message}
        </pre>
        <Button type="button" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    );
  }
}

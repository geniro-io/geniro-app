import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from './ui/button';

/**
 * Root error boundary — a rendering crash anywhere below must surface the
 * error and a way back, never a silently blank window (React unmounts the
 * whole tree when an error escapes uncaught). Class component by necessity:
 * React has no hook equivalent of componentDidCatch.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('renderer crashed:', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) {
      return this.props.children;
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

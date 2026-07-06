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
        <pre className="max-h-48 max-w-xl overflow-auto rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          {this.state.error.message}
        </pre>
        <Button type="button" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    );
  }
}

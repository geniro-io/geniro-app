import { Check, CircleAlert, LoaderCircle } from 'lucide-react';

import { cn } from '../components/ui/utils';
import type { AutosaveState } from './use-autosave';

/**
 * The builder's bottom status bar — a slim, always-present strip replacing the
 * old top notice line and the Save button. It reports what the canvas holds
 * (left), the last transient outcome such as an export path (middle), and the
 * autosave state (right). Being always-present means it never reflows the
 * canvas by appearing/disappearing the way the top notice did.
 */

const SAVE_LABEL = {
  idle: 'Up to date',
  saving: 'Saving…',
  saved: 'Saved',
  failed: 'Not saved',
} as const satisfies Record<AutosaveState, string>;

const SAVE_TONE = {
  idle: 'text-muted-foreground',
  saving: 'text-muted-foreground',
  saved: 'text-success',
  failed: 'text-destructive',
} as const satisfies Record<AutosaveState, string>;

function SaveIcon({ state }: { state: AutosaveState }): React.JSX.Element {
  if (state === 'saving') {
    return <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />;
  }
  if (state === 'failed') {
    return <CircleAlert aria-hidden="true" className="size-3" />;
  }
  return (
    <Check
      aria-hidden="true"
      className={cn('size-3', state === 'idle' && 'opacity-50')}
    />
  );
}

export function BuilderStatusBar({
  nodeCount,
  edgeCount,
  message,
  saveState,
}: {
  nodeCount: number;
  edgeCount: number;
  /** Transient outcome of the last explicit action (e.g. an export path). */
  message: string | null;
  saveState: AutosaveState;
}): React.JSX.Element {
  return (
    <footer className="flex shrink-0 items-center gap-3 border-t border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
      <span className="shrink-0 tabular-nums">
        {nodeCount} {nodeCount === 1 ? 'node' : 'nodes'} · {edgeCount}{' '}
        {edgeCount === 1 ? 'edge' : 'edges'}
      </span>
      {message ? (
        <span className="min-w-0 flex-1 truncate" title={message}>
          {message}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {/* Announced politely: with no Save button this line is the only place
          the app confirms the user's work is on disk. */}
      <span
        role="status"
        aria-live="polite"
        className={cn(
          'flex shrink-0 items-center gap-1.5 transition-colors',
          SAVE_TONE[saveState],
        )}>
        <SaveIcon state={saveState} />
        {SAVE_LABEL[saveState]}
      </span>
    </footer>
  );
}

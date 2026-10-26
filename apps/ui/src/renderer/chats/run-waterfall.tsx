import { ChartGantt } from 'lucide-react';

import { Dialog } from '../components/ui/dialog';
import { RunWaterfallDialog } from './run-waterfall-dialog';
import type { RunWaterfallState } from './use-run-waterfall';

/** The popup's title while there is no run to draw, matching the full view's. */
const TITLE = 'Where the run went';

/**
 * "Where the run went", opened from the agents panel's control row.
 *
 * It used to be a card IN the panel with a button out to the full view. The
 * panel now holds only what belongs to the thread itself — its agents, pull
 * requests and pages — so the run's analysis opens straight into the full view
 * (`run-waterfall-dialog.tsx`), and this wrapper owns only the states that have
 * no run to draw: the first read still out, a failed read, and a thread that
 * has not run yet. Each says so in a small popup of its own rather than opening
 * an empty full-screen view.
 *
 * Props-only: the owner holds the read, gated on this popup being open, so it
 * cannot fetch a second, differently-timed copy of the same run.
 */
export function RunWaterfallPopup({
  open,
  onClose,
  state,
  onJump,
}: {
  open: boolean;
  onClose: () => void;
  state: RunWaterfallState;
  /** Open a transcript row by seq — the full view's "Open in chat". */
  onJump?: (seq: number) => void;
}): React.JSX.Element | null {
  const { data, loading, error } = state;
  if (error === null && data !== null && data.lanes.length > 0) {
    return (
      <RunWaterfallDialog
        open={open}
        onClose={onClose}
        data={data}
        onJump={onJump}
      />
    );
  }
  // A read that has not started yet (the popup's first frame, before the
  // owner's effect raises `loading`) is still a read on its way.
  const message =
    error ??
    (loading || data === null
      ? 'reading the run…'
      : 'nothing has run in this thread yet');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <ChartGantt
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
          {TITLE}
        </span>
      }>
      <p className="text-sm text-muted-foreground">{message}</p>
    </Dialog>
  );
}

import { ChevronRight, LogIn, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';

/**
 * A red, click-expandable failure row: collapsed it shows the caption and
 * the first line of the message; expanded it shows the full text verbatim
 * (monospace, wrap-preserved). Used by `error` items and the daemon's
 * `system` advisories — both report something going wrong, so both wear
 * the destructive tone.
 */
export function AlertRow({
  caption,
  message,
  onSignIn,
}: {
  /** Row caption, e.g. "flaky · error". */
  caption: string;
  message: string;
  /**
   * Sign the failing CLI back in, when the daemon recognised this failure as a
   * lapsed account session.
   *
   * On the row rather than off in the chrome because this is where the user
   * meets the problem: an expired session rendered as a stack trace, with the
   * fix two screens away, is the gap this closes. Omitted for every failure
   * with no known cure, which is nearly all of them.
   *
   * Named for the ONE recovery that exists rather than taken as a generic
   * `{label, icon, onClick}` action: the row renders a sign-in glyph, so a
   * general seam would let a future non-login cure render under it. Widen this
   * when a second recovery is real, and let its icon arrive with it.
   */
  onSignIn?: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const firstLine = message.split('\n', 1)[0] ?? '';
  return (
    <div
      data-role="error"
      className="flex w-full flex-col rounded-xl border border-destructive/30 bg-destructive/10 text-sm text-destructive">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Hide details' : 'Show full details'}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left">
        <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide opacity-70">
          {caption}
        </span>
        {!open ? (
          <span className="min-w-0 flex-1 truncate text-xs">{firstLine}</span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 transition-transform',
            open && 'rotate-90',
          )}
        />
      </button>
      {open ? (
        <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-all px-3 pb-2.5 font-mono text-xs">
          {message}
        </pre>
      ) : null}
      {onSignIn ? (
        // A SIBLING of the expand button, never inside it: a button nested in a
        // button is invalid, and the click would toggle the row on its way out.
        // Shown collapsed as well as expanded — the cure is the point of the
        // row, and hiding it behind a disclosure is where it was already.
        <div className="flex px-3 pb-2.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            title="Open this agent’s CLI sign-in in your terminal, then send the message again"
            onClick={onSignIn}>
            <LogIn aria-hidden="true" className="size-3.5 shrink-0" />
            Sign in
          </Button>
        </div>
      ) : null}
    </div>
  );
}

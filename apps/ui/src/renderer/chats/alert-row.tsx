import { ChevronRight, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

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
}: {
  /** Row caption, e.g. "flaky · error". */
  caption: string;
  message: string;
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
    </div>
  );
}

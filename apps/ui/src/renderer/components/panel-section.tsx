import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * A titled block at the foot of a side panel — Artifacts, Pull requests.
 *
 * The heading is ONE string used as both the visible label and the section's
 * accessible name, so the two cannot drift into disagreeing about what the block
 * is called.
 *
 * `count` is drawn beside the label, in the caption's own muted colour: a
 * folded or scrolled block still says how much it holds, and the same number
 * a reader would otherwise count by eye.
 *
 * With `onToggle` the heading folds the section: a chevron before the label
 * says which way, and `open` is the caller's.
 */
export function PanelSection({
  label,
  count,
  action,
  open,
  onToggle,
  children,
}: {
  label: string;
  count?: number;
  /** A control for the whole section — a filter — at the heading's end. */
  action?: ReactNode;
  /** Whether a foldable section is open; read only with `onToggle`. */
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}): React.JSX.Element {
  const caption = (
    <>
      {label}
      {count === undefined ? null : (
        <span
          data-slot="panel-section-count"
          className="font-normal tabular-nums">
          {count}
        </span>
      )}
    </>
  );
  const captionClass =
    'flex items-baseline gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase';
  const heading =
    onToggle === undefined ? (
      <span className={captionClass}>{caption}</span>
    ) : (
      <button
        type="button"
        data-slot="panel-section-toggle"
        aria-expanded={open ?? false}
        className={`${captionClass} min-w-0 rounded-control text-left hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none`}
        onClick={onToggle}>
        {open ? (
          <ChevronDown aria-hidden className="size-3 shrink-0 self-center" />
        ) : (
          <ChevronRight aria-hidden className="size-3 shrink-0 self-center" />
        )}
        <span className="truncate">{label}</span>
        {count === undefined ? null : (
          <span
            data-slot="panel-section-count"
            className="font-normal tabular-nums">
            {count}
          </span>
        )}
      </button>
    );
  return (
    <section
      aria-label={label}
      className="flex shrink-0 flex-col gap-1.5 border-t border-border px-3 py-2.5">
      {action === undefined ? (
        heading
      ) : (
        <div className="flex min-w-0 items-center justify-between gap-2">
          {heading}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

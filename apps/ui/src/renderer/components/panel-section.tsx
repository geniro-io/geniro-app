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
 */
export function PanelSection({
  label,
  count,
  children,
}: {
  label: string;
  count?: number;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <section
      aria-label={label}
      className="flex shrink-0 flex-col gap-1.5 border-t border-border px-3 py-2.5">
      <span className="flex items-baseline gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
        {count === undefined ? null : (
          <span
            data-slot="panel-section-count"
            className="font-normal tabular-nums">
            {count}
          </span>
        )}
      </span>
      {children}
    </section>
  );
}

import type { ReactNode } from 'react';

/**
 * A titled block at the foot of a side panel — Artifacts, Pull requests.
 *
 * The heading is ONE string used as both the visible label and the section's
 * accessible name, so the two cannot drift into disagreeing about what the block
 * is called.
 */
export function PanelSection({
  label,
  action,
  children,
}: {
  label: string;
  /** A control for the whole section — a filter — at the heading's end. */
  action?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  const heading = (
    <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {label}
    </span>
  );
  return (
    <section
      aria-label={label}
      className="flex shrink-0 flex-col gap-1 border-t border-border px-3 py-2">
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

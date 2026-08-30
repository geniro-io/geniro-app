import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * One outward link in a side panel — a published artifact, a pull request.
 *
 * A plain anchor opened by the SHELL: main's window-open handler hands an https
 * target to the user's browser and denies every other scheme, so this needs no
 * IPC of its own and cannot be pointed at something that would run.
 */
export function PanelLinkRow({
  href,
  title,
  tooltip,
  icon,
  meta,
}: {
  href: string;
  title: string;
  /** The row's `title` attribute — the full value its label truncates. */
  tooltip?: string;
  icon?: ReactNode;
  /** Trailing detail that must never give up width to the title. */
  meta?: ReactNode;
}): React.JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={tooltip}
      className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm shadow-panel-sm hover:bg-sidebar-accent">
      {icon}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {meta === undefined ? null : (
        <span
          data-slot="panel-link-meta"
          className="shrink-0 text-xs text-muted-foreground">
          {meta}
        </span>
      )}
      <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
    </a>
  );
}

import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from './ui/utils';

/**
 * What a row in a side panel LOOKS like — named once so the anchor form and the
 * in-app form below cannot drift apart after one retint.
 */
const PANEL_ROW_CLASS =
  'flex w-full items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-left text-sm shadow-panel-sm hover:bg-sidebar-accent';

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
  detail,
}: {
  href: string;
  title: string;
  /** The row's `title` attribute — the full value its label truncates. */
  tooltip?: string;
  icon?: ReactNode;
  /** Trailing detail that must never give up width to the title. */
  meta?: ReactNode;
  /**
   * A second line UNDER the title, for a row whose figures would otherwise
   * squeeze its title to a couple of words — a pull request's number, size
   * and line counts beside its title left the title `feat(ui): …` in a 280px
   * panel. The title gets the whole first line.
   */
  detail?: ReactNode;
}): React.JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={tooltip}
      className={cn(PANEL_ROW_CLASS, detail !== undefined && 'items-start')}>
      {icon === undefined ? null : (
        // On a two-line row the glyph sits beside the TITLE, not between the
        // two lines.
        <span
          className={cn(
            'flex shrink-0 items-center',
            detail !== undefined && 'h-5',
          )}>
          {icon}
        </span>
      )}
      {detail === undefined ? (
        <span className="min-w-0 flex-1 truncate">{title}</span>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{title}</span>
          <span
            data-slot="panel-link-detail"
            className="truncate text-xs text-muted-foreground">
            {detail}
          </span>
        </span>
      )}
      {meta === undefined ? null : (
        <span
          data-slot="panel-link-meta"
          className="shrink-0 text-xs text-muted-foreground">
          {meta}
        </span>
      )}
      <ExternalLink
        className={cn(
          'size-3 shrink-0 text-muted-foreground',
          detail !== undefined && 'mt-1',
        )}
      />
    </a>
  );
}

/**
 * The same row, for something that lives INSIDE the app — a press that takes
 * the reader somewhere in this window rather than out to a browser.
 *
 * A `<button>` and not an anchor with a fake href, and it carries no
 * external-link glyph: that mark is a promise about where the press goes, and
 * putting it on an in-app jump is the one thing this row must not do.
 */
export function PanelActionRow({
  onClick,
  title,
  tooltip,
  icon,
  meta,
}: {
  onClick: () => void;
  title: string;
  /** The row's `title` attribute — the full value its label truncates. */
  tooltip?: string;
  icon?: ReactNode;
  /** Trailing detail that must never give up width to the title. */
  meta?: ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={tooltip}
      onClick={onClick}
      className={PANEL_ROW_CLASS}>
      {icon}
      <span className="min-w-0 flex-1 truncate font-normal">{title}</span>
      {meta === undefined ? null : (
        <span
          data-slot="panel-link-meta"
          className="shrink-0 text-xs font-normal text-muted-foreground">
          {meta}
        </span>
      )}
    </button>
  );
}

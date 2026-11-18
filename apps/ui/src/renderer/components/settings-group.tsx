import type React from 'react';

import { HelpHint } from './help-hint';
import { cn } from './ui/utils';

/**
 * One named group of a settings page: an icon, a title with its "?"
 * explanation and a one-line note, then its rows with the group's own actions
 * above them at the right.
 *
 * Once the page is wide enough the name and note stand in a column of their
 * own beside the rows, so a long page reads as named blocks rather than one run
 * of cards. Its parent carries `@container` ({@link SettingsGroups}), so that
 * happens at the page's width rather than the window's. A list too long for
 * the rows' column opens in a dialog from a row instead.
 */
export function SettingsGroup({
  icon,
  title,
  description,
  hint,
  actions,
  className,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  /** One line: what this group is for. */
  description?: React.ReactNode;
  /** The plain-language explanation behind the "?" after the title. */
  hint?: React.ReactNode;
  /** Buttons that act on the whole group (Re-check, New entry). */
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      data-slot="settings-group"
      aria-label={title}
      className={cn(
        'grid min-w-0 grid-cols-1 gap-x-10 gap-y-4 @[52rem]:grid-cols-[15rem_minmax(0,1fr)]',
        className,
      )}>
      <header className="flex min-w-0 items-start gap-3 @[52rem]:flex-col @[52rem]:gap-2">
        {icon === undefined ? null : (
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&>svg]:size-4">
            {icon}
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-1.5">
            <h2 className="text-base font-semibold">{title}</h2>
            {hint === undefined ? null : (
              <HelpHint subject={title}>{hint}</HelpHint>
            )}
          </span>
          {description === undefined ? null : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      </header>
      <div className="flex min-w-0 flex-col gap-3">
        {actions === undefined || actions === null ? null : (
          <div
            data-slot="settings-group-actions"
            className="flex flex-wrap items-center justify-end gap-2">
            {actions}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}

/**
 * The column a settings page's groups stand in, each separated from the next
 * by a rule so the eye finds where one ends.
 */
export function SettingsGroups({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      data-slot="settings-groups"
      className={cn(
        '@container flex flex-col gap-8 [&>[data-slot=settings-group]+[data-slot=settings-group]]:border-t [&>[data-slot=settings-group]+[data-slot=settings-group]]:border-border [&>[data-slot=settings-group]+[data-slot=settings-group]]:pt-8',
        className,
      )}>
      {children}
    </div>
  );
}

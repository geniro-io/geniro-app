import * as React from 'react';

import { cn } from './ui/utils';

/**
 * A centered muted one-liner for loading / connecting / empty-list states. The
 * one component for "there's nothing here yet" messaging so those states are
 * visually consistent.
 */
export function EmptyState({
  className,
  children,
  icon,
  actions,
  ...props
}: React.ComponentProps<'div'> & {
  /** A glyph drawn in a muted circle above the message. */
  icon?: React.ReactNode;
  /** What to do about it, under the message. */
  actions?: React.ReactNode;
}): React.JSX.Element {
  if (icon === undefined && actions === undefined) {
    return (
      <div
        className={cn(
          'flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground',
          className,
        )}
        {...props}>
        {children}
      </div>
    );
  }
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center gap-4 px-6 py-12 text-center',
        className,
      )}
      {...props}>
      {icon === undefined ? null : (
        <span className="flex size-14 items-center justify-center rounded-pill bg-muted text-muted-foreground [&_svg]:size-6">
          {icon}
        </span>
      )}
      <p className="max-w-sm text-base text-muted-foreground">{children}</p>
      {actions === undefined ? null : (
        <div className="flex flex-wrap justify-center gap-2">{actions}</div>
      )}
    </div>
  );
}

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
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element {
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

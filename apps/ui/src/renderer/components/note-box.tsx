import * as React from 'react';

import { cn } from './ui/utils';

/**
 * A muted informational block — a soft-tinted rounded panel for inline notes and
 * hints. Replaces the ad-hoc "muted background chip" recipe duplicated across
 * screens.
 */
export function NoteBox({
  className,
  children,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      className={cn(
        'rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground',
        className,
      )}
      {...props}>
      {children}
    </div>
  );
}

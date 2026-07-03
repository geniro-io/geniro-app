import * as React from 'react';

import { cn } from './ui/utils';

/**
 * An inline error line — destructive-tinted small text. The single component for
 * surfacing recoverable errors (onboarding footer, chat error strip, forms).
 */
export function ErrorText({
  className,
  children,
  ...props
}: React.ComponentProps<'p'>): React.JSX.Element {
  return (
    <p
      role="alert"
      className={cn('text-sm text-destructive', className)}
      {...props}>
      {children}
    </p>
  );
}

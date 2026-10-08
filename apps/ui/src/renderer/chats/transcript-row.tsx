import type { ComponentProps } from 'react';

import { cn } from '../components/ui/utils';

/** A flex parent lets message bubbles align themselves, including centered notes. */
export function TranscriptRow({
  className,
  ...props
}: ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      {...props}
      className={cn(
        'flex flex-col empty:hidden rounded-md transition-colors duration-500',
        className,
      )}
    />
  );
}

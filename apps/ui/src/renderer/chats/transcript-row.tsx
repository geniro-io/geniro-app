import type { ComponentProps } from 'react';

import { cn } from '../components/ui/utils';

/**
 * The wash on the row a jump landed on — a fill rather than an outline, and net
 * zero in layout (`-my-1 py-1`), so marking a row moves none of its neighbours.
 */
export const JUMP_MARK_CLASS = '-mx-2 -my-1 bg-accent/60 px-2 py-1';

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

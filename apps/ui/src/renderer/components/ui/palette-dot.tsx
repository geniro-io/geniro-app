import type * as React from 'react';

import type { ProfileColor } from '../../../shared/contracts';
import { PALETTE_DOT_CLASS } from './palette';
import { cn } from './utils';

const SIZE_CLASS = {
  sm: 'size-2',
  md: 'size-2.5',
  lg: 'size-3',
} as const;

/**
 * One colour of the app's palette, drawn as a dot — the swatch in a colour
 * picker's rows and the mark a coloured thing wears.
 *
 * Decorative by default (`aria-hidden`): the colour's NAME is what a screen
 * reader needs, and every place that shows a dot already says it in text.
 */
export function PaletteDot({
  color,
  size = 'md',
  className,
  ...props
}: {
  color: ProfileColor;
  size?: keyof typeof SIZE_CLASS;
} & Omit<React.ComponentProps<'span'>, 'color'>): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-color={color}
      {...props}
      className={cn(
        'shrink-0 rounded-full',
        SIZE_CLASS[size],
        PALETTE_DOT_CLASS[color],
        className,
      )}
    />
  );
}

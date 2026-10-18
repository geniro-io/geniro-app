import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './utils';

/** The fill's colour: the ordinary reading, or one past where it should be. */
const fillVariants = cva('h-full rounded-full', {
  variants: {
    tone: {
      default: 'bg-primary',
      danger: 'bg-destructive',
    },
  },
  defaultVariants: { tone: 'default' },
});

/**
 * A horizontal determinate progress track.
 *
 * The linear counterpart to {@link ProgressRing}, which stays the right shape
 * for a figure sitting inline beside text (the context meter). This is for the
 * other case — a bar spanning a strip or a settings row, where the length IS
 * the message.
 *
 * `fraction` of `null` is an INDETERMINATE stretch, not zero: a step whose
 * length nothing can report (an unpacking copy) draws a moving sliver rather
 * than an empty bar, which reads as stalled.
 */
export function ProgressBar({
  fraction,
  label,
  className,
  tone,
}: {
  /** Fill fraction 0..1 (clamped), or null for indeterminate. */
  fraction: number | null;
  /** Accessible name — required, since a bar with no name conveys nothing. */
  label: string;
  className?: string;
} & VariantProps<typeof fillVariants>): React.JSX.Element {
  const clamped = fraction === null ? null : Math.min(1, Math.max(0, fraction));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      // Omitted while indeterminate, which is exactly what an absent
      // `aria-valuenow` means to a screen reader.
      aria-valuenow={clamped === null ? undefined : Math.round(clamped * 100)}
      className={cn(
        'h-1 w-full overflow-hidden rounded-full bg-border',
        className,
      )}>
      <div
        className={cn(
          fillVariants({ tone }),
          clamped === null
            ? 'w-1/3 animate-[progress-slide_1.4s_ease-in-out_infinite]'
            : 'transition-[width] duration-200',
        )}
        style={clamped === null ? undefined : { width: `${clamped * 100}%` }}
      />
    </div>
  );
}

import { cn } from './utils';

/**
 * A small unfilled-circle progress indicator: a token-coloured track ring with
 * an arc that fills clockwise to `fraction` (0..1, clamped). The arc draws in
 * `currentColor`, so callers set its tone with a text-* class; the track reads
 * `var(--border)`. Give it a `label` whenever it conveys data — that becomes
 * the accessible name.
 */
export function ProgressRing({
  fraction,
  size = 16,
  strokeWidth = 2.5,
  label,
  className,
}: {
  /** Fill fraction 0..1 — values outside the range are clamped. */
  fraction: number;
  size?: number;
  strokeWidth?: number;
  /** Accessible name (aria-label); omit only for purely decorative rings. */
  label?: string;
  className?: string;
}): React.JSX.Element {
  const clamped = Math.min(1, Math.max(0, fraction));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('shrink-0', className)}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--border)"
        strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={`${circumference * clamped} ${circumference}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

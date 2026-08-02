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
  centerLabel,
  className,
}: {
  /** Fill fraction 0..1 — values outside the range are clamped. */
  fraction: number;
  size?: number;
  strokeWidth?: number;
  /** Accessible name (aria-label); omit only for purely decorative rings. */
  label?: string;
  /**
   * Short text drawn INSIDE the ring — a percentage, typically.
   *
   * An SVG `<text>` rather than a `children` slot: the ring IS an `<svg>`, so
   * arbitrary JSX cannot be nested in it, and a wrapper div positioning HTML
   * over the circle would not scale with `size`. Keep it to a few characters;
   * the ring has to be legible at 16px.
   */
  centerLabel?: string;
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
      {centerLabel ? (
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          // `currentColor` matches the arc, and the size is derived from the
          // ring so one prop still controls the whole component's scale.
          fill="currentColor"
          fontSize={size * 0.4}
          // The ring already carries the accessible name; the glyphs would
          // otherwise be read out a second time.
          aria-hidden>
          {centerLabel}
        </text>
      ) : null}
    </svg>
  );
}

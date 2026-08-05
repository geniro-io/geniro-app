import { ProgressRing } from '../components/ui/progress-ring';
import { cn } from '../components/ui/utils';
import { formatTokens, formatUsd } from './agent-activity';

/**
 * Fraction above which the ring warns, then alarms. Below `WARN_AT` it is
 * GREEN — a traffic light, not a brand accent: the ring exists to say how much
 * room is left, and `text-primary` (the app's caramel) reads as decoration
 * beside every other primary-toned control rather than as "you are fine".
 */
const WARN_AT = 0.7;
const ALARM_AT = 0.9;

/**
 * How full one agent's context window is, plus what the run has cost.
 *
 * EXTRACTED from the agents panel rather than written fresh: the panel already
 * rendered exactly this, and the header needed the same thing. One component
 * serving both is what makes them structurally incapable of disagreeing — the
 * defect was a header with no readout at all beside a panel that had one.
 *
 * Renders nothing when there is nothing to say, so callers can place it
 * unconditionally.
 */
export function ContextMeter({
  contextTokens,
  contextWindowTokens,
  spentUsd = null,
  className,
}: {
  /** Prompt-side tokens of the latest request, or null when unknown. */
  contextTokens: number | null;
  /** The model's own window; falls back to the assumed default. */
  contextWindowTokens: number | null;
  /** Total spend across the run's turns, or null to omit. */
  spentUsd?: number | null;
  className?: string;
}): React.JSX.Element | null {
  // The model's OWN window, or NOTHING. A window of 0 is rejected here, not
  // just upstream: this is the ONE place that divides by it, and the result
  // ("Context Infinity% full") would land in the accessible name.
  //
  // There is deliberately no assumed fallback. Substituting a flat 200k made
  // the meter state a denominator nobody had reported — so a 1M-window model
  // read as a fifth full before it had said anything, which is precisely the
  // "wrong context" this shows. When the window is unknown the count is shown
  // bare and the ring is withheld: "26k used" is true, "26k / 200k · 13%" was
  // not.
  const window =
    contextWindowTokens !== null && contextWindowTokens > 0
      ? contextWindowTokens
      : null;
  const fraction =
    contextTokens !== null && window !== null ? contextTokens / window : null;
  if (contextTokens === null && spentUsd === null) {
    return null;
  }
  const percent = fraction === null ? null : Math.round(fraction * 100);
  return (
    <span
      className={cn(
        'flex items-center gap-2 text-xs text-muted-foreground',
        className,
      )}>
      {contextTokens !== null ? (
        <span
          title={
            window === null
              ? "Context of the latest turn — the model's window has not been reported yet"
              : "Context of the latest turn / the model's window"
          }>
          ctx {formatTokens(contextTokens)}
          {window === null ? null : ` / ${formatTokens(window)}`}
        </span>
      ) : null}
      {spentUsd !== null ? (
        <span title="Total spend across this run's turns">
          {formatUsd(spentUsd)}
        </span>
      ) : null}
      {fraction !== null && percent !== null ? (
        <ProgressRing
          fraction={fraction}
          // ONE size and ONE label everywhere. There was a `showPercent` prop
          // that made the header's ring the only readable one; a ring the user
          // has to hover to read is a decoration, and two variants of the same
          // meter is exactly the drift this component exists to prevent.
          size={22}
          // Thinner than the primitive's default: the arc has to frame two or
          // three glyphs at this diameter, not crowd them.
          strokeWidth={2}
          label={`Context ${percent}% full`}
          centerLabel={`${percent}%`}
          className={cn(
            'ml-auto',
            fraction >= ALARM_AT
              ? 'text-destructive'
              : fraction >= WARN_AT
                ? 'text-warning'
                : 'text-success',
          )}
        />
      ) : null}
    </span>
  );
}

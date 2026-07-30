import { ProgressRing } from '../components/ui/progress-ring';
import { cn } from '../components/ui/utils';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  formatTokens,
  formatUsd,
} from './agent-activity';

/** Fraction above which the ring warns, then alarms. */
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
  showPercent = false,
  className,
}: {
  /** Prompt-side tokens of the latest request, or null when unknown. */
  contextTokens: number | null;
  /** The model's own window; falls back to the assumed default. */
  contextWindowTokens: number | null;
  /** Total spend across the run's turns, or null to omit. */
  spentUsd?: number | null;
  /** Draw the percentage inside the ring (the header's roomier placement). */
  showPercent?: boolean;
  className?: string;
}): React.JSX.Element | null {
  // The model's OWN window when its CLI named one — the same figure must scale
  // the ring and label the denominator, or a 1M-window model reads as full at
  // a fifth of its context.
  //
  // A window of 0 is rejected here, not just upstream: this is the ONE place
  // that divides by it, `?? DEFAULT` passes 0 straight through, and the result
  // ("Context Infinity% full") lands in the accessible name — so the guard
  // belongs where the division is, whatever any caller hands in.
  const window =
    contextWindowTokens !== null && contextWindowTokens > 0
      ? contextWindowTokens
      : DEFAULT_CONTEXT_WINDOW_TOKENS;
  const fraction = contextTokens !== null ? contextTokens / window : null;
  if (fraction === null && spentUsd === null) {
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
        <span title="Context of the latest turn / the model's window">
          ctx {formatTokens(contextTokens)} / {formatTokens(window)}
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
          size={showPercent ? 28 : 16}
          label={`Context ${percent}% full`}
          centerLabel={showPercent ? `${percent}` : undefined}
          className={cn(
            'ml-auto',
            fraction >= ALARM_AT
              ? 'text-destructive'
              : fraction >= WARN_AT
                ? 'text-warning'
                : 'text-primary',
          )}
        />
      ) : null}
    </span>
  );
}

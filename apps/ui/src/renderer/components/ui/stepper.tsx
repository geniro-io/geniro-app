import { Minus, Plus } from 'lucide-react';

import { Button } from './button';
import { cn } from './utils';

/**
 * A small whole number, changed by pressing − and +.
 *
 * It replaces `<Input type="number">` for the same reason `select.tsx` replaces
 * the native `<select>`: the spinner a browser draws is an OS control. It
 * ignores every token (measured against this palette as two grey chevrons in a
 * light box, on a dark panel), its hit target is a few pixels tall, it is
 * invisible to the DOM so nothing can assert on it, and it comes with a text
 * field that accepts `-4` and `1e9` — so the caller ends up validating input
 * for a control whose whole job is to offer three or four values.
 *
 * There is no text field here at all. That is the point rather than a
 * simplification: a stepper over a bounded range makes an out-of-range value
 * unreachable by construction, where a number field makes it typeable and
 * leaves every call site to refuse it.
 *
 * `role="spinbutton"` is the ARIA role for exactly this, and it is honoured
 * rather than merely spelled — the value is focusable and answers the arrow,
 * page and Home/End keys a screen reader tells its user to press. A role that
 * promises keyboard handling it does not implement is worse for that user than
 * no role at all.
 */
export function Stepper({
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled = false,
  className,
  'aria-label': ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  className?: string;
  /** Names the VALUE, which is the spinbutton — the buttons derive theirs. */
  'aria-label': string;
}): React.JSX.Element {
  // Clamped rather than trusted: `value` is whatever the caller holds, and a
  // row written by an older build (or a daemon whose ceiling has since moved)
  // must not make the control offer a step it cannot take.
  const current = Math.min(max, Math.max(min, value));
  const atMin = current <= min;
  const atMax = current >= max;

  const move = (next: number): void => {
    const clamped = Math.min(max, Math.max(min, next));
    if (clamped !== current) {
      onChange(clamped);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    // The keys a spinbutton owes its user, per ARIA. Each one PREVENTS the
    // default: ArrowUp/Down would otherwise scroll the panel this sits in.
    const by: Record<string, number> = {
      ArrowUp: step,
      ArrowRight: step,
      ArrowDown: -step,
      ArrowLeft: -step,
      PageUp: step,
      PageDown: -step,
    };
    if (event.key in by) {
      event.preventDefault();
      move(current + (by[event.key] ?? 0));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      move(min);
    } else if (event.key === 'End') {
      event.preventDefault();
      move(max);
    }
  };

  return (
    <div
      data-slot="stepper"
      className={cn(
        'flex h-8 shrink-0 items-center rounded-md border border-input',
        disabled && 'opacity-50',
        className,
      )}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        // `rounded-r-none` so the two ends follow the group's own radius and
        // the middle stays square — three separately rounded controls in a
        // bordered box read as three controls that happen to be adjacent.
        className="size-7 shrink-0 rounded-r-none text-muted-foreground"
        aria-label={`Decrease ${ariaLabel}`}
        disabled={disabled || atMin}
        onClick={() => {
          move(current - step);
        }}>
        <Minus className="size-3.5" aria-hidden />
      </Button>
      <span
        role="spinbutton"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel}
        aria-valuenow={current}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-disabled={disabled || undefined}
        onKeyDown={disabled ? undefined : onKeyDown}
        // `tabular-nums` so the group does not change width as the value goes
        // from 9 to 10, which on a proportional face nudges both buttons.
        className="min-w-8 px-1 text-center text-xs tabular-nums focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
        {current}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 rounded-l-none text-muted-foreground"
        aria-label={`Increase ${ariaLabel}`}
        disabled={disabled || atMax}
        onClick={() => {
          move(current + step);
        }}>
        <Plus className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}

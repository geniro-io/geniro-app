import * as React from 'react';

/**
 * A token-driven range input with its value shown at the right.
 *
 * The filled part is the track's own background: a gradient that paints `--primary`
 * up to the value and `--switch-background` beyond it, so the fill follows the value
 * with no second element. The thumb is `--primary`. The one inline style is that
 * fill position, which changes with the value; every size and colour is a utility.
 */
function Slider({
  value,
  min,
  max,
  step = 1,
  onValueChange,
  label,
  disabled = false,
  id,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onValueChange: (next: number) => void;
  label?: string;
  disabled?: boolean;
  id?: string;
}): React.JSX.Element {
  const filled =
    max > min
      ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100))
      : 0;
  return (
    <div data-slot="slider" className="flex w-full items-center gap-3">
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        disabled={disabled}
        onChange={(event) => onValueChange(Number(event.currentTarget.value))}
        style={{
          backgroundImage: `linear-gradient(to right, var(--primary) ${filled}%, var(--switch-background) ${filled}%)`,
        }}
        className="h-4 w-full min-w-0 cursor-pointer appearance-none rounded-full bg-transparent outline-none [-webkit-appearance:none] [background-position:center] [background-repeat:no-repeat] [background-size:100%_0.375rem] focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-slider-runnable-track]:h-4 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-panel-sm [&::-moz-range-track]:h-4 [&::-moz-range-track]:bg-transparent [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:shadow-panel-sm"
      />
      <output
        htmlFor={id}
        className="min-w-10 text-right text-sm tabular-nums text-muted-foreground">
        {value}
      </output>
    </div>
  );
}

export { Slider };

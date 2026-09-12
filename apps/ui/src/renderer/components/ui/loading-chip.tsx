import { chipVariants } from './chip';
import { Spinner } from './spinner';
import { cn } from './utils';

/**
 * The waiting state for a chip whose vocabulary is still being asked of a CLI
 * or the daemon's capabilities probe.
 *
 * Several axes here have no such state of their own the way a model list's
 * own `loading` flag does — an unfetched one renders NOTHING, which reads as
 * "this CLI offers none" rather than "not answered yet", and makes the rows
 * around it reflow the moment the real answer lands. This is the single
 * source of that placeholder.
 *
 * `noun` names what is loading and composes the accessible name
 * (`Loading <noun>`) and the default title; the VISIBLE text defaults to a
 * bare "Loading…", which no noun composes. Both are overridable because call
 * sites word them differently: one names the CLI inline ("Loading models for
 * cursor-agent…") and prints the noun on the chip itself, another leaves the
 * default standing since the row's own label beside it already names the axis.
 */
export function LoadingChip({
  noun,
  title,
  visibleText,
  className,
}: {
  noun: string;
  title?: string;
  visibleText?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      data-slot="select-chip"
      aria-busy="true"
      aria-label={`Loading ${noun}`}
      title={title ?? `Loading ${noun}…`}
      className={cn(
        chipVariants({ interactive: false, tone: 'active' }),
        className,
      )}>
      <Spinner className="size-3.5" />
      <span className="truncate">{visibleText ?? 'Loading…'}</span>
    </span>
  );
}

import { cn } from './ui/utils';

export type StatusTone = 'ok' | 'warn' | 'bad' | 'unknown';

const TONE = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-destructive',
  unknown: 'bg-muted-foreground/50',
} as const satisfies Record<StatusTone, string>;

/**
 * An 8px status circle. The one implementation of the "coloured dot" pattern —
 * used for CLI detection, daemon connection, and run state — so ok/bad/unknown
 * always reads the same across the app.
 */
export function StatusDot({
  tone,
  label,
  className,
}: {
  tone: StatusTone;
  /** The state in words, announced and shown on hover, where no word stands beside the dot. */
  label?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      data-slot="status-dot"
      data-tone={tone}
      {...(label === undefined
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': label, title: label })}
      className={cn('inline-block size-2 rounded-full', TONE[tone], className)}
    />
  );
}

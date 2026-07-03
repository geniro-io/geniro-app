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
  className,
}: {
  tone: StatusTone;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-2 rounded-full', TONE[tone], className)}
    />
  );
}

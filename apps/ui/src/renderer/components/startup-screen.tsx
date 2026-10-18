import { PlugZap, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Logo } from './logo';
import { Button } from './ui/button';
import { ProgressBar } from './ui/progress-bar';
import { cn } from './ui/utils';

/** After this long the wait is counted out loud, so a slow start reads as working. */
const SHOW_ELAPSED_AFTER_MS = 4_000;

/** After this long the screen says why a start can be slow. */
const EXPLAIN_AFTER_MS = 12_000;

/**
 * What the window shows until the local engine first answers — and, when it
 * could not be started, why, with the way back.
 *
 * It replaced a centred "Connecting to the daemon…" under a red "Not connected"
 * strip, which is what every launch looked like for as long as the daemon took
 * to boot: an ordinary start dressed as a failure, with nothing to say it was
 * still moving. A start is not an error, so nothing here is red until the
 * supervisor has actually given up (`reason`).
 *
 * The clock counts from `since`, the moment the shell began waiting, rather
 * than from this component's mount, so a re-render never restarts it.
 */
export function StartupScreen({
  since,
  reason = null,
  onRetry,
  className,
}: {
  /** When the wait began (epoch ms). */
  since: number;
  /** The supervisor's own words for why the start failed; null while starting. */
  reason?: string | null;
  /** Starts again; the caller puts the screen back in its starting state. */
  onRetry?: () => void;
  className?: string;
}): React.JSX.Element {
  const failed = reason !== null;
  const now = useNow(!failed);
  const elapsedMs = Math.max(0, now - since);

  return (
    <div
      data-slot="startup-screen"
      data-state={failed ? 'failed' : 'starting'}
      // `status`, not `alert`: the starting phase is a standing condition, and
      // a failure that interrupts on every Retry would re-announce itself.
      role="status"
      aria-live="polite"
      className={cn(
        'flex h-full min-h-0 flex-col items-center justify-center px-6 py-10 text-center',
        className,
      )}>
      <div className="flex w-full max-w-sm flex-col items-center">
        <Logo size="hero" className="max-w-full opacity-90" />
        {failed ? (
          <>
            <div className="mt-8 flex items-center gap-2 text-sm font-medium text-foreground">
              <PlugZap
                aria-hidden="true"
                className="size-4 shrink-0 text-destructive"
              />
              The local engine didn’t start
            </div>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Everything in Geniro runs through it, so nothing can load until it
              does.
            </p>
            {/* The reason carries a pid, a path or a port, so it wraps. */}
            <p className="mt-4 w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-left font-mono text-xs leading-relaxed break-words text-muted-foreground">
              {reason}
            </p>
            {onRetry ? (
              <Button type="button" className="mt-6 gap-1.5" onClick={onRetry}>
                <RefreshCw aria-hidden="true" className="size-3.5" />
                Retry
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <ProgressBar
              fraction={null}
              label="Starting Geniro"
              className="mt-10 w-48"
            />
            <p className="mt-5 text-sm font-medium text-foreground">
              Starting Geniro
            </p>
            <p className="mt-1.5 min-h-[1lh] text-xs text-muted-foreground tabular-nums">
              {elapsedMs >= SHOW_ELAPSED_AFTER_MS
                ? `Opening your chats and workflows · ${Math.floor(elapsedMs / 1000)}s`
                : 'Opening your chats and workflows'}
            </p>
            <p
              className={cn(
                'mt-6 max-w-xs text-xs leading-relaxed text-muted-foreground transition-opacity duration-500',
                elapsedMs >= EXPLAIN_AFTER_MS ? 'opacity-100' : 'opacity-0',
              )}
              aria-hidden={elapsedMs < EXPLAIN_AFTER_MS}>
              Still working. A large history takes longer to open, most of all
              on the first launch after a restart.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** The current time, re-read every second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

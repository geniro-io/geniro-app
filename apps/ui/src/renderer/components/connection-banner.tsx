import { PlugZap, RefreshCw } from 'lucide-react';

import { Button } from './ui/button';
import { cn } from './ui/utils';

/**
 * The app-wide "the daemon is not answering" strip.
 *
 * Everything in this app is a call to a loopback daemon, and until now a
 * daemon that was down, still starting, or refusing the launch token showed up
 * as one thing: a 6px status dot at the bottom of the nav rail changing
 * colour. Every screen then simply did nothing — the chat list stayed empty,
 * Send appeared to work and silently failed, and the transcript pane sat on
 * "Connecting to the daemon…" forever with no statement of what was wrong or
 * whether it would ever finish. That is the reported "if we have a problem
 * with the api/connection, we should see it in the UI".
 *
 * Deliberately NOT an {@link ErrorBanner}: that one is dismissible because
 * nothing the user types will clear it. This is the opposite case — the strip
 * IS the connection state, so dismissing it would only hide a fact that is
 * still true, and it disappears by itself the moment the socket opens.
 *
 * `reason` is the daemon's / Socket.IO's own words, never composed here. It is
 * what distinguishes "connection refused" (the daemon is not running) from an
 * authentication failure (a stale handle after a restart), and those need
 * different things from the user.
 */
export function ConnectionBanner({
  reason,
  retrying = false,
  onRetry,
  className,
}: {
  /** Why the last attempt failed, or null while no reason has been reported. */
  reason: string | null;
  retrying?: boolean;
  onRetry: () => void;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      // `role="status"` rather than `alert`: this is a standing condition a
      // screen reader should announce politely, not an interruption. It is
      // also re-rendered on every retry, and `alert` would re-interrupt each
      // time.
      role="status"
      className={cn(
        'flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive',
        className,
      )}>
      <PlugZap aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">
        <span className="font-medium">Not connected to the local engine.</span>{' '}
        {/* The reason carries a host, a port and sometimes a response body, so
            it wraps rather than widening the strip past the window. */}
        {reason ?? 'Nothing on this machine is answering yet.'}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-6 shrink-0 gap-1 px-2 text-[11px]"
        disabled={retrying}
        onClick={onRetry}>
        <RefreshCw
          aria-hidden="true"
          className={cn('size-3 shrink-0', retrying && 'animate-spin')}
        />
        Retry
      </Button>
    </div>
  );
}

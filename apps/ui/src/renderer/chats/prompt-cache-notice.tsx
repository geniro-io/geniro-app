import { Hourglass, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '../components/ui/utils';
import { formatTokens } from './agent-activity';
import { formatElapsed } from './live-row';
import { msUntilPromptCacheNotice, promptCacheState } from './prompt-cache';

/**
 * How often the line re-reads the clock once it is showing: every second while
 * it counts down, every half minute once the cache has lapsed and the only
 * figure left is "how long ago", stated in whole minutes.
 */
const COUNTDOWN_TICK_MS = 1_000;
const EXPIRED_TICK_MS = 30_000;

/** `<1m`, `12m`, `1h 5m` — how long ago the cache lapsed, to the minute. */
function formatAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return '<1m';
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * The line at the bottom of the message box saying the prompt cache is about
 * to lapse, or has — because the next message is then a full re-write of the
 * conversation to the cache, which on a long thread is the most expensive turn
 * in it. See `prompt-cache.ts` for where the expiry comes from.
 *
 * It owns its clock, so the composer around it does not re-render with it, and
 * it SLEEPS until the countdown is due: an hour-long cache costs one timer, not
 * 3,600 renders of nothing.
 */
export function PromptCacheNotice({
  expiresAt,
  contextTokens,
}: {
  /** `RunDto.promptCacheExpiresAt`. */
  expiresAt: string | null | undefined;
  /** How much the next message would re-cache, when known. */
  contextTokens: number | null | undefined;
}): React.JSX.Element | null {
  const [now, setNow] = useState(() => Date.now());
  const state = promptCacheState(expiresAt, now);
  useEffect(() => {
    // A FRESH clock, not the rendered one: while nothing shows, `now` can be a
    // whole sleep old, and a new expiry (the next turn settling) measured
    // against it would wake the line late.
    const current = Date.now();
    const fresh = promptCacheState(expiresAt, current);
    if (fresh?.kind !== promptCacheState(expiresAt, now)?.kind) {
      setNow(current);
      return;
    }
    const delay =
      fresh === null
        ? msUntilPromptCacheNotice(expiresAt, current)
        : fresh.kind === 'expiring'
          ? COUNTDOWN_TICK_MS
          : EXPIRED_TICK_MS;
    if (delay === null) {
      return;
    }
    // Capped: a timer past 2^31-1 ms fires at once, which would turn a long
    // sleep into a tight loop.
    const id = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(delay, 2_147_483_647),
    );
    return () => window.clearTimeout(id);
  }, [expiresAt, now]);

  if (state === null) {
    return null;
  }
  const size =
    typeof contextTokens === 'number' && contextTokens > 0
      ? `~${formatTokens(contextTokens)} tokens of context`
      : 'the whole conversation';
  const expired = state.kind === 'expired';
  const Icon = expired ? TriangleAlert : Hourglass;
  return (
    <p
      data-slot="prompt-cache-notice"
      data-state={state.kind}
      className={cn(
        'flex items-start gap-1.5 px-4 pb-1 text-xs',
        expired ? 'text-warning' : 'text-muted-foreground',
      )}>
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>
        {expired
          ? `Prompt cache expired ${formatAgo(state.sinceMs)} ago — the next message re-caches ${size} at full price.`
          : `Prompt cache expires in ${formatElapsed(state.remainingMs)} — send now to keep the next message cheap.`}
      </span>
    </p>
  );
}

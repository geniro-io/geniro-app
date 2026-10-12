import { Hourglass, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '../components/ui/utils';
import { formatCacheSpan } from './prompt-cache';

/**
 * Past this share of its window, an instance whose cache has lapsed is cheaper
 * to replace than to continue. TWIN: the daemon's `COLD_RESUME_CONTEXT_PERCENT`
 * and `isColdAndLarge` (`graphs/utils/prompt-cache-standing.ts`), the rule a
 * calling agent is held to — compared unrounded on both sides, so the badge
 * and the agent's refusal agree at the boundary.
 */
const COLD_RESUME_CONTEXT_PERCENT = 50;

/**
 * A percentage to a tenth, never rounded down onto the threshold. TWIN of the
 * daemon's `statedPercent`.
 */
function statedPercent(percent: number): number {
  const tenths = Math.round(percent * 10) / 10;
  return percent > COLD_RESUME_CONTEXT_PERCENT &&
    tenths <= COLD_RESUME_CONTEXT_PERCENT
    ? Math.ceil(percent * 10) / 10
    : tenths;
}

/** The badge states minutes, so a minute is as often as it can change. */
const TICK_MS = 60_000;

/**
 * Where ONE agent instance's prompt cache stands, beside its context ring: how
 * long it stays warm, or that it has lapsed — and, when it has lapsed over a
 * window more than half full, that a fresh instance is the cheaper way on.
 *
 * Nothing while the instance is working (its cache is being written as it
 * goes) or when its CLI reports no cache lifetime: an expiry nobody measured
 * is never drawn.
 */
export function PromptCacheBadge({
  expiresAt,
  contextTokens,
  contextWindowTokens,
  live = false,
}: {
  expiresAt: string | null | undefined;
  contextTokens: number | null | undefined;
  contextWindowTokens: number | null | undefined;
  live?: boolean;
}): React.JSX.Element | null {
  const [now, setNow] = useState(() => Date.now());
  const at = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  const shown = !live && Number.isFinite(at);
  useEffect(() => {
    if (!shown) {
      return;
    }
    // Re-read at once as well: the clock may be a long sleep old by the time
    // a new expiry arrives.
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [shown, at]);
  if (!shown) {
    return null;
  }
  const remaining = at - now;
  const expired = remaining <= 0;
  const percent =
    typeof contextTokens === 'number' &&
    typeof contextWindowTokens === 'number' &&
    contextTokens > 0 &&
    contextWindowTokens > 0
      ? (contextTokens / contextWindowTokens) * 100
      : null;
  const startFresh =
    expired && percent !== null && percent > COLD_RESUME_CONTEXT_PERCENT;
  const title = expired
    ? startFresh
      ? `Prompt cache expired ${formatCacheSpan(-remaining)} ago and the context is ${statedPercent(percent ?? 0)}% full — a new instance with a brief is cheaper than continuing this one.`
      : `Prompt cache expired ${formatCacheSpan(-remaining)} ago — continuing this instance re-caches its whole context at full price.`
    : `Prompt cache warm for ${formatCacheSpan(remaining)} more — continuing this instance until then is cheap.`;
  const Icon = expired ? TriangleAlert : Hourglass;
  return (
    <span
      data-slot="prompt-cache-badge"
      data-state={startFresh ? 'start-fresh' : expired ? 'expired' : 'warm'}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums',
        startFresh ? 'text-warning' : 'text-muted-foreground',
      )}>
      <Icon aria-hidden className="size-3" />
      {expired ? 'cold' : formatCacheSpan(remaining)}
    </span>
  );
}

import { useEffect, useState } from 'react';

import { Spinner } from '../components/ui/spinner';
import { formatTokens } from './agent-activity';
import { MessageBubble } from './message-bubble';

/**
 * The two synthetic transcript rows that describe what an agent is doing RIGHT
 * NOW: a reasoning stretch, and the silence between one thing and the next.
 *
 * They own their own clock rather than being handed an elapsed number, and that
 * is the whole reason they are components at all. The elapsed time used to be
 * computed inside the transcript fold, from `Date.now()` at render — so it only
 * advanced when a delta happened to arrive, which is why the counter visibly
 * jumped (30s → 34s) instead of counting seconds. A row that ticks itself
 * advances every second, and re-renders nothing but itself.
 */

/**
 * Marks a synthetic transcript row as one of the two LIVE-state rows rather
 * than words on their way to becoming durable.
 *
 * Both ride the `reasoning` item kind — already styled as the muted aside they
 * are — and this field is what tells them apart at the render site, so neither
 * needed a new entry type threading through every switch of the fold. The
 * numbers ride raw for the same reason the rows tick themselves: an elapsed
 * time baked into the fold only advances when a delta happens to arrive.
 *
 * It lives HERE rather than beside the fold that writes it so the writer and
 * the reader can both depend on it without depending on each other.
 */
export type LiveRowKind = 'thinking' | 'working';

/** Read the live-row marker off a synthetic item's payload, or null. */
export function liveRowKind(payload: unknown): LiveRowKind | null {
  if (payload && typeof payload === 'object' && 'live' in payload) {
    const value = (payload as { live: unknown }).live;
    if (value === 'thinking' || value === 'working') {
      return value;
    }
  }
  return null;
}

/** Re-render once a second, so an elapsed readout counts real seconds. */
function useSecondsTick(): void {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1_000);
    return () => window.clearInterval(id);
  }, []);
}

/** `12s`, `1m 5s` — the elapsed form both rows read. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * One reasoning stretch: how much thinking it has cost, and for how long.
 *
 * Both numbers are per STRETCH. A turn that thinks, runs tools, then thinks
 * again is two separate waits, and each gets its own row — the daemon's
 * stretch id is what keys them apart, so a new stretch mounts a fresh
 * component with a clock starting at zero.
 */
export function ThinkingRow({
  since,
  tokens,
}: {
  /** Epoch ms this stretch began. */
  since: number;
  /** Reasoning tokens spent in this stretch so far. */
  tokens: number;
}): React.JSX.Element {
  useSecondsTick();
  return (
    <LiveRow
      role="thinking"
      label={`Thinking… ${formatTokens(tokens)} tokens · ${formatElapsed(Date.now() - since)}`}
    />
  );
}

/**
 * The agent is working but has nothing to show for it yet — between a tool
 * batch finishing and the next words or reasoning delta arriving.
 *
 * Without this the transcript went silent for those stretches and the only
 * signal left was the status in the chat header, which is not where the user is
 * looking. The clock runs from MOUNT rather than from a published timestamp:
 * "how long this has been quiet" is exactly the question it answers, and it
 * needs no state threaded through the fold to answer it.
 */
export function WorkingRow(): React.JSX.Element {
  const [mountedAt] = useState(() => Date.now());
  useSecondsTick();
  return (
    <LiveRow
      role="working"
      label={`Working… ${formatElapsed(Date.now() - mountedAt)}`}
    />
  );
}

/**
 * The shell both rows share — bubble, spinner, label. Split out so a change to
 * the chrome cannot land on one live row and not the other.
 */
function LiveRow({
  role,
  label,
}: {
  role: string;
  label: string;
}): React.JSX.Element {
  return (
    <MessageBubble variant="reasoning" role={role}>
      <div className="flex items-center gap-1.5 italic">
        <Spinner />
        <span>{label}</span>
      </div>
    </MessageBubble>
  );
}

import { TITLE_BAR_CONTROL } from '../components/title-bar';
import { cn } from '../components/ui/utils';
import { WaitMark } from './wait-mark';
import {
  OWED_STATES,
  type OwedState,
  waitCounts,
  type WaitReading,
} from './waiting';

/** The chord the status line names; `useNextWaitingShortcut` is its listener. */
export const NEXT_WAITING_KEYS = '⌘J';

/** Words that read after a count of any size: `2 unread`, `1 asking`. */
const COUNT_WORDS: Record<OwedState, string> = {
  asking: 'asking',
  failed: 'failed',
  unseen: 'unread',
};

/**
 * The title bar's "what is waiting on you" line: a count per wait, and the
 * chord that goes to the longest one. A waiting thread never moves itself to
 * the front — this line says it is there, and a press (or the chord) goes to it.
 * Nothing at all while nothing waits.
 */
export function WaitingStatus({
  readings,
  onJump,
}: {
  /** Every thread's wait, ranked (`waitReadings`). */
  readings: readonly WaitReading[];
  onJump: () => void;
}): React.JSX.Element | null {
  const counts = waitCounts(readings);
  const parts = OWED_STATES.filter((state) => counts[state] > 0);
  if (parts.length === 0) {
    return null;
  }
  const spoken = parts
    .map((state) => `${counts[state]} ${COUNT_WORDS[state]}`)
    .join(', ');
  return (
    <button
      type="button"
      data-slot="waiting-status"
      onClick={onJump}
      aria-label={`${spoken} — open the one that has waited longest (${NEXT_WAITING_KEYS})`}
      title={`Open the thread that has waited longest (${NEXT_WAITING_KEYS})`}
      className={cn(
        TITLE_BAR_CONTROL,
        'flex h-6 items-center gap-2 px-1.5 text-xs',
      )}>
      {parts.map((state) => (
        <span
          key={state}
          data-wait-count={state}
          className="flex items-center gap-1 tabular-nums">
          <WaitMark state={state} />
          {counts[state]}
        </span>
      ))}
      <span aria-hidden="true" className="font-mono text-[11px]">
        {NEXT_WAITING_KEYS}
      </span>
    </button>
  );
}

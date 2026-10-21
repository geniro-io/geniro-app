import { cn } from '../components/ui/utils';
import { RunStatusIcon, type RunStatusKind } from './run-status';
import type { WaitState } from './waiting';

/**
 * Each wait drawn with the status vocabulary's own glyph, so a mark on a card
 * or in the title bar reads as the badge on the thread it leads to. `working`
 * is `held`'s hourglass rather than the spinner: a mark that says "nothing is
 * owed" must not move.
 */
export const WAIT_META: Record<
  WaitState,
  { status: RunStatusKind; label: string }
> = {
  asking: { status: 'needs-input', label: 'waiting on you' },
  failed: { status: 'failed', label: 'turn failed' },
  unseen: { status: 'completed', label: 'new reply' },
  working: { status: 'held', label: 'working' },
};

export function WaitMark({
  state,
  className,
}: {
  state: WaitState;
  className?: string;
}): React.JSX.Element {
  const { status, label } = WAIT_META[state];
  return (
    <span
      data-slot="wait-mark"
      data-wait-state={state}
      title={label}
      className={cn('flex shrink-0 items-center', className)}>
      <RunStatusIcon status={status} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

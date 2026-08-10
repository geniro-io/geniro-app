import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  Loader2,
  MessageCircleQuestion,
  MinusCircle,
} from 'lucide-react';

import { cn } from '../components/ui/utils';

/**
 * Everything a run or a node can be, display-wise: the run statuses, the
 * node-only `skipped`, the "hasn't started yet" `idle`, and `needs-input` —
 * which no daemon row ever carries. See {@link displayRunStatus}.
 */
export type RunStatusKind =
  | 'pending'
  | 'running'
  | 'needs-input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'idle';

/**
 * The one status → icon/tone/label mapping, so a run's or agent's state reads
 * the same everywhere (sidebar rows, the transcript header, the agents panel):
 * running spins in the accent tone, terminal states are
 * success/destructive/muted.
 *
 * `label` exists because the call sites were printing the raw key, and
 * `needs-input` is a slug rather than a sentence.
 */
export const RUN_STATUS_META: Record<
  RunStatusKind,
  { icon: typeof Clock; className: string; label: string }
> = {
  pending: {
    icon: Clock,
    className: 'text-muted-foreground',
    label: 'pending',
  },
  running: { icon: Loader2, className: 'text-primary', label: 'running' },
  // Warning-toned, not accent: it is the one state that will not advance on
  // its own, so it must read as "you are the blocker" rather than as another
  // shade of busy — and the icon is deliberately not a spinner, for the same
  // reason.
  'needs-input': {
    icon: MessageCircleQuestion,
    className: 'text-warning',
    label: 'needs more info',
  },
  completed: {
    icon: CircleCheck,
    className: 'text-success',
    label: 'completed',
  },
  failed: { icon: CircleX, className: 'text-destructive', label: 'failed' },
  cancelled: {
    icon: Ban,
    className: 'text-muted-foreground',
    label: 'cancelled',
  },
  skipped: {
    icon: MinusCircle,
    className: 'text-muted-foreground',
    label: 'skipped',
  },
  idle: {
    icon: CircleDashed,
    className: 'text-muted-foreground',
    label: 'idle',
  },
};

/**
 * What a run's badge should SAY, as opposed to what its row happens to hold.
 *
 * Three independent writers touch `run.status` — the terminal-item handler, the
 * client-wide `run_status` broadcast, and the snapshot refetch — so a snapshot
 * taken mid-turn can land after a fresher event and re-assert a stale
 * `completed`. That is the reported flicker: a chat reading "completed" while
 * its agent is visibly still thinking. The row is not the authority on whether
 * work is in flight; the live plane is.
 *
 * The order is the contract:
 *
 * 1. An unanswered question outranks everything. The turn IS still open at the
 *    daemon, so every other signal says `running` — but nothing will move until
 *    a human answers, and calling that "running" is what left the user watching
 *    a spinner that was in fact waiting on them.
 * 2. A live turn outranks a terminal row. `streaming` is cleared on activate
 *    and re-derived from the replayed transcript on reconnect, so it cannot go
 *    stale-true across a chat switch — which is what makes it safe to let it
 *    veto a `completed` that only a racing refetch asserted.
 * 3. Otherwise the row is right.
 *
 * Pure and exported, so the badge rule is testable without mounting a chat.
 */
export function displayRunStatus({
  status,
  streaming,
  awaitingAnswer,
}: {
  /** The status on the run row, as the daemon last reported it. */
  status: RunStatusKind;
  /** A turn's live plane is active for this run. */
  streaming: boolean;
  /** This run has an approval or question card still open. */
  awaitingAnswer: boolean;
}): RunStatusKind {
  if (awaitingAnswer) {
    return 'needs-input';
  }
  // failed/cancelled are deliberately NOT overridden: both are settle paths
  // that can arrive while the live plane has yet to be torn down, and painting
  // a cancelled run as running would hide the very thing the user just asked
  // for.
  if (streaming && status !== 'failed' && status !== 'cancelled') {
    return 'running';
  }
  return status;
}

/** The status glyph alone — spinning while running. */
export function RunStatusIcon({
  status,
  className,
}: {
  status: RunStatusKind;
  className?: string;
}): React.JSX.Element {
  const meta = RUN_STATUS_META[status];
  const Icon = meta.icon;
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        'size-3 shrink-0',
        meta.className,
        status === 'running' && 'animate-spin',
        className,
      )}
    />
  );
}

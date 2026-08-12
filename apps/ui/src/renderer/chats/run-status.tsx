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
 * 2. Work in flight outranks a terminal row — a live turn (`streaming`) or a
 *    background sub-agent that has not reported back. `streaming` is cleared on
 *    activate and re-derived from the replayed transcript on reconnect, so it
 *    cannot go stale-true across a chat switch — which is what makes it safe to
 *    let it veto a `completed` that only a racing refetch asserted.
 * 3. Otherwise the row is right.
 *
 * Pure and exported, so the badge rule is testable without mounting a chat.
 */
export function displayRunStatus({
  status,
  streaming,
  awaitingAnswer,
  subagentRunning = false,
}: {
  /** The status on the run row, as the daemon last reported it. */
  status: RunStatusKind;
  /** A turn's live plane is active for this run. */
  streaming: boolean;
  /** This run has an approval or question card still open. */
  awaitingAnswer: boolean;
  /**
   * At least one background sub-agent of this run is still working.
   *
   * Ranked with {@link streaming} rather than under it, because the two go out
   * of step in exactly the case this exists for: the daemon deliberately drops
   * a sub-agent's deltas from the live tail, so a delegating turn can have
   * nothing streaming while several delegates are mid-flight. The run then read
   * as its stale row — the reported "thread says completed while sub-agents are
   * visibly working".
   *
   * Defaulted, so the many call sites that know nothing about sub-agents (a
   * background row, a workflow node) are unaffected.
   */
  subagentRunning?: boolean;
}): RunStatusKind {
  if (awaitingAnswer) {
    return 'needs-input';
  }
  // failed/cancelled are deliberately NOT overridden: both are settle paths
  // that can arrive while the live plane has yet to be torn down, and painting
  // a cancelled run as running would hide the very thing the user just asked
  // for. A still-running sub-agent does not earn an exception — a cancelled run
  // is precisely where a delegate's last rows are still landing.
  if (
    (streaming || subagentRunning) &&
    status !== 'failed' &&
    status !== 'cancelled'
  ) {
    return 'running';
  }
  return status;
}

/**
 * This run has stopped for good — nothing further will arrive for it.
 *
 * Deliberately takes the status {@link displayRunStatus} produced rather than
 * the raw row, so "has it stopped" is answered by the same authority the badge
 * shows. Reading the row directly is how a transcript came to contradict its
 * own header.
 *
 * `pending` and `idle` are NOT settled: they are states a run has yet to leave,
 * not ones it has finished in. `needs-input` is not either — the turn is open
 * and waiting on a human.
 */
export function isSettledRunStatus(status: RunStatusKind): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'skipped'
  );
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
      // The glyph and its tone ARE the status here — nothing beside a tool row
      // or a panel thread row spells it in words — so the status is also stated
      // in the DOM. Otherwise the only thing a test (or anyone inspecting the
      // page) can read it off is a lucide class name, which changes with the
      // icon rather than with the meaning.
      data-status={status}
      className={cn(
        'size-3 shrink-0',
        meta.className,
        status === 'running' && 'animate-spin',
        className,
      )}
    />
  );
}

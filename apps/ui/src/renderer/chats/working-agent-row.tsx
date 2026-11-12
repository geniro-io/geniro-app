import { MemberAvatar } from '../components/member-avatar';
import { StatusDot, type StatusTone } from '../components/status-dot';
import { cn } from '../components/ui/utils';
import { useSecondTick } from '../components/use-second-tick';
import { callClockTitle, useCallClockMs } from './call-clock';
import { formatElapsed } from './live-row';
import { formatDuration } from './turn-duration';
import {
  isWorkingAgentLive,
  type WorkingAgentRow,
  type WorkingAgentState,
} from './working-agents';

const STATE_LOOK: Record<
  WorkingAgentState,
  {
    word: string;
    tone: StatusTone;
    hollow?: boolean;
    pill: string;
    rail: string;
  }
> = {
  working: {
    word: 'working',
    tone: 'ok',
    pill: 'bg-success/15 text-success',
    rail: 'border-success/50',
  },
  waiting: {
    word: 'waiting',
    tone: 'ok',
    hollow: true,
    pill: 'bg-accent text-muted-foreground',
    rail: 'border-success/30',
  },
  queued: {
    word: 'queued',
    tone: 'unknown',
    hollow: true,
    pill: 'bg-accent text-muted-foreground',
    rail: 'border-border',
  },
  quiet: {
    word: 'gone quiet',
    tone: 'warn',
    pill: 'bg-warning/15 text-warning',
    rail: 'border-warning/50',
  },
  finished: {
    word: 'finished',
    tone: 'unknown',
    pill: 'bg-accent text-muted-foreground',
    rail: 'border-border',
  },
  failed: {
    word: 'failed',
    tone: 'bad',
    pill: 'bg-destructive/15 text-destructive',
    rail: 'border-destructive/50',
  },
  stopped: {
    word: 'stopped',
    tone: 'unknown',
    pill: 'bg-accent text-muted-foreground',
    rail: 'border-border',
  },
};

/** The colour of the line a conversation's messages hang on. */
export function workingAgentRailClass(state: WorkingAgentState): string {
  return STATE_LOOK[state].rail;
}

export function WorkingAgentStateDot({
  state,
  className,
}: {
  state: WorkingAgentState;
  className?: string;
}): React.JSX.Element {
  const look = STATE_LOOK[state];
  return (
    <StatusDot
      tone={look.tone}
      className={cn(
        'size-1.5 shrink-0',
        look.hollow === true && 'border border-muted-foreground bg-transparent',
        className,
      )}
    />
  );
}

/**
 * The daemon's clock for the conversation, the one its card reads; only a live
 * call the daemon has no clock for yet is timed from its own start.
 */
export function WorkingAgentElapsed({
  row,
}: {
  row: WorkingAgentRow;
}): React.JSX.Element | null {
  const live = isWorkingAgentLive(row);
  const clockMs = useCallClockMs(row.clocks, live);
  useSecondTick(live && clockMs === null);
  const ms =
    clockMs ??
    (live && row.startedAt !== null ? Date.now() - row.startedAt : null);
  return ms === null || ms <= 0 ? null : (
    <span
      data-slot="working-agent-elapsed"
      title={callClockTitle(ms, live)}
      className="ml-auto shrink-0 text-xs text-foreground/80 tabular-nums">
      {live ? formatElapsed(ms) : formatDuration(ms)}
    </span>
  );
}

/** Where the call stands, in its colour, and who asked for it. */
function WorkingAgentStateLine({
  row,
}: {
  row: WorkingAgentRow;
}): React.JSX.Element {
  const look = STATE_LOOK[row.state];
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      <span
        data-slot="working-agent-state-pill"
        data-state={row.state}
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px font-medium',
          look.pill,
        )}>
        <WorkingAgentStateDot state={row.state} />
        <span data-slot="working-agent-state">{look.word}</span>
      </span>
      {row.state === 'waiting' && row.waitingFor.length > 0 ? (
        <span
          data-slot="working-agent-waiting-for"
          title={`Waiting for ${row.waitingFor.join(', ')}`}
          className="truncate">
          for {row.waitingFor.join(', ')}
        </span>
      ) : null}
      {row.caller === null ? null : (
        <span className="truncate">from {row.caller}</span>
      )}
    </span>
  );
}

/** One current run under its agent's name: where it stands, for how long, and what for. */
export function WorkingAgentRunFacts({
  row,
}: {
  row: WorkingAgentRow;
}): React.JSX.Element {
  return (
    <div
      data-slot="working-agent-run"
      className="flex min-w-0 flex-col gap-1.5">
      <span className="flex min-w-0 items-center gap-2">
        <WorkingAgentStateLine row={row} />
        <WorkingAgentElapsed row={row} />
      </span>
      {row.title === null ? null : (
        <span
          data-slot="working-agent-run-title"
          className="line-clamp-2 text-[13px] leading-snug font-medium break-words text-foreground">
          {row.title}
        </span>
      )}
    </div>
  );
}

/** What the conversation was asked to do, the line the eye goes to under its head. */
export function WorkingAgentTitle({
  row,
}: {
  row: WorkingAgentRow;
}): React.JSX.Element | null {
  return row.title === null ? null : (
    <span
      data-slot="working-agent-title"
      className="line-clamp-2 text-[13px] leading-snug font-medium break-words text-foreground">
      {row.title}
    </span>
  );
}

/** Who was called, for how long, where the call stands and who asked: the face holds both lines. */
export function WorkingAgentHead({
  row,
}: {
  row: WorkingAgentRow;
}): React.JSX.Element {
  return (
    <span
      data-slot="working-agent-head"
      className="flex w-full min-w-0 items-center gap-2.5">
      <MemberAvatar
        name={row.callee}
        colorKey={row.calleeKey}
        avatar={row.calleeAvatar}
        size={40}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-foreground">
            {row.callee}
          </span>
          <WorkingAgentElapsed row={row} />
        </span>
        <WorkingAgentStateLine row={row} />
      </span>
    </span>
  );
}

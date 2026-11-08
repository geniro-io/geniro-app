import { MemberAvatar } from '../components/member-avatar';
import { StatusDot, type StatusTone } from '../components/status-dot';
import { cn } from '../components/ui/utils';
import { useSecondTick } from '../components/use-second-tick';
import { AvatarPair } from './avatar-pair';
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
  { word: string; tone: StatusTone; hollow?: boolean }
> = {
  working: { word: 'working', tone: 'ok' },
  queued: { word: 'queued', tone: 'unknown', hollow: true },
  quiet: { word: 'gone quiet', tone: 'warn' },
  finished: { word: 'finished', tone: 'unknown' },
  failed: { word: 'failed', tone: 'bad' },
  stopped: { word: 'stopped', tone: 'unknown' },
};

/** Who was called, and by whom when that is recorded. */
export function WorkingAgentFaces({
  row,
}: {
  row: WorkingAgentRow;
}): React.JSX.Element {
  return (
    <span
      data-slot="working-agent-faces"
      className="flex h-5 shrink-0 items-center">
      {row.caller === null ? (
        <MemberAvatar
          name={row.callee}
          colorKey={row.calleeKey}
          avatar={row.calleeAvatar}
          size={20}
        />
      ) : (
        <AvatarPair
          caller={row.caller}
          callerKey={row.callerKey ?? row.caller}
          callerAvatar={row.callerAvatar}
          callee={row.callee}
          calleeKey={row.calleeKey}
          calleeAvatar={row.calleeAvatar}
        />
      )}
    </span>
  );
}

/**
 * The daemon's clock for the conversation, the one its card reads; only a live
 * call the daemon has no clock for yet is timed from its own start.
 */
function WorkingAgentElapsed({
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
      className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
      {live ? formatElapsed(ms) : formatDuration(ms)}
    </span>
  );
}

/** The name, the time, the state, who asked and what for. */
export function WorkingAgentFacts({
  row,
}: {
  row: WorkingAgentRow;
}): React.JSX.Element {
  const state = STATE_LOOK[row.state];
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex h-5 min-w-0 items-center gap-2">
        <span className="truncate text-xs font-medium text-foreground">
          {row.callee}
        </span>
        <WorkingAgentElapsed row={row} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <StatusDot
          tone={state.tone}
          className={cn(
            'size-1.5 shrink-0',
            state.hollow === true &&
              'border border-muted-foreground bg-transparent',
          )}
        />
        <span data-slot="working-agent-state" className="shrink-0">
          {state.word}
        </span>
        {row.caller === null ? null : (
          <>
            <span aria-hidden="true">·</span>
            <span className="truncate">from {row.caller}</span>
          </>
        )}
      </span>
      {row.title === null ? null : (
        <span
          data-slot="working-agent-title"
          className="line-clamp-2 text-xs break-words text-foreground/80">
          {row.title}
        </span>
      )}
    </span>
  );
}

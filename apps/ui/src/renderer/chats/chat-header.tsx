import { IdCard, PanelRight, Workflow as WorkflowIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '../components/ui/button';
import { Chip } from '../components/ui/chip';
import { cn } from '../components/ui/utils';
import { folderName as configDirName } from './directory-select';
import { formatElapsed } from './live-row';
import { formatRelativeTime } from './relative-time';
import {
  RUN_STATUS_META,
  RunStatusIcon,
  type RunStatusKind,
} from './run-status';

/**
 * How long the turn on screen has been running, ticking every second.
 *
 * Its own component so the second-by-second re-render stays here instead of
 * repainting the whole header — the same reason the transcript's live rows own
 * their clocks. Renders nothing without a start time, so the header can place
 * it unconditionally.
 */
function ElapsedTime({
  since,
}: {
  since: string | null;
}): React.JSX.Element | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (since === null) {
      return;
    }
    const id = window.setInterval(() => tick((n) => n + 1), 1_000);
    return () => window.clearInterval(id);
  }, [since]);
  const startedAt = since === null ? NaN : Date.parse(since);
  if (!Number.isFinite(startedAt)) {
    return null;
  }
  return (
    <span
      className="shrink-0 text-xs tabular-nums text-muted-foreground"
      title="How long this turn has been running">
      · {formatElapsed(Date.now() - startedAt)}
    </span>
  );
}

/**
 * The open transcript's header: the same identity the sidebar row carries —
 * label, live status (spinning while running), last activity. The run's
 * working directory lives in the composer's folder chip below, not here.
 *
 * On the right, only the side-panel toggle. The context meter used to sit here
 * too and has moved into the composer, beside Send — the question it answers
 * ("how much room is left") is asked while composing the next message, not
 * while reading the header, and the eye leaves this row as soon as the
 * conversation starts. Everything per-agent (threads, per-node context) stays
 * in the panel.
 */
export function ChatHeader({
  label,
  isWorkflow,
  agentKind = null,
  configDir = null,
  status,
  lastActivityAt,
  turnStartedAt = null,
  sidePanelOpen,
  onToggleSidePanel,
}: {
  label: string;
  isWorkflow: boolean;
  /**
   * The CLI driving a single-agent chat. It lives HERE rather than in the
   * composer below: it is fixed for the life of the run, and a chip stating an
   * unchangeable fact sat among five that change things. Null for a workflow
   * run, whose agents are per node — the panel lists those.
   */
  agentKind?: string | null;
  /**
   * The agent config directory this run's turns use — which account/profile
   * the CLI runs as — or null for the CLI's own default.
   *
   * HERE, beside the agent, for the same reason the agent is: it is fixed for
   * the life of the run and it changes what the conversation IS — a different
   * profile is a different subscription, different plugins, different history.
   * A run on the default profile shows nothing, because "the usual one" is not
   * news; only a run that departs from it earns a chip.
   */
  configDir?: string | null;
  /**
   * The DISPLAY status, not the daemon's row value — wider than `RunStatus`
   * because `needs-input` is derived in the renderer (`displayRunStatus`) and
   * no daemon row ever carries it.
   */
  status: RunStatusKind;
  lastActivityAt: string;
  /**
   * When the turn currently on screen began — the ISO timestamp of the message
   * that started it. Drives the running clock; null while nothing is running.
   *
   * A TIMESTAMP rather than an elapsed number, for the same reason the
   * daemon's `thinkingSince` is one: a duration computed by the owner freezes
   * at the moment it was passed, and keeping it moving would mean re-rendering
   * the header once a second from above. It is read from the transcript, so it
   * survives a reload mid-turn — a clock started at mount would restart at zero
   * and claim a four-minute turn had just begun.
   */
  turnStartedAt?: string | null;
  sidePanelOpen: boolean;
  onToggleSidePanel: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border bg-card/60 px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        {isWorkflow ? (
          <WorkflowIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
        ) : null}
        <h2 className="min-w-0 truncate text-sm font-semibold tracking-tight">
          {label}
        </h2>
        {agentKind ? <Chip className="h-6 px-1.5">{agentKind}</Chip> : null}
        {configDir ? (
          // The LEAF, with the whole path on hover: a profile directory is
          // usually deep (`~/Desktop/Projects/X/.claude-thing`) and the header
          // is a one-line identity, not a place to read paths.
          <Chip
            className="h-6 min-w-0 px-1.5"
            title={`Agent config directory (account / profile): ${configDir}`}>
            <IdCard />
            <span className="max-w-40 truncate">
              {configDirName(configDir)}
            </span>
          </Chip>
        ) : null}
        <span className="flex shrink-0 items-center gap-1 text-xs">
          <RunStatusIcon status={status} />
          <span className={RUN_STATUS_META[status].className}>
            {RUN_STATUS_META[status].label}
          </span>
        </span>
        {status === 'running' ? (
          // WHILE running the question is "how long has this been going", not
          // "when did it last do something" — the relative time reads
          // "just now" for the whole turn and answers nothing.
          <ElapsedTime since={turnStartedAt} />
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">
            · {formatRelativeTime(lastActivityAt)}
          </span>
        )}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant={sidePanelOpen ? 'secondary' : 'ghost'}
          size="icon"
          className={cn('size-7', !sidePanelOpen && 'text-muted-foreground')}
          aria-label={sidePanelOpen ? 'Close side panel' : 'Open side panel'}
          title="Side panel"
          onClick={onToggleSidePanel}>
          <PanelRight className="size-4 shrink-0" />
        </Button>
      </div>
    </div>
  );
}

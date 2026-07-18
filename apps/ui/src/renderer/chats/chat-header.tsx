import { PanelRight, Workflow as WorkflowIcon } from 'lucide-react';

import type { ChatRunStatus } from '../../shared/contracts';
import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';
import { formatRelativeTime } from './relative-time';
import { RUN_STATUS_META, RunStatusIcon } from './run-status';

/**
 * The open transcript's header: the same identity the sidebar row carries —
 * label, live status (spinning while running), last activity. The run's
 * working directory lives in the composer's folder chip below, not here.
 * On the right, ONLY the generic side-panel toggle — the panel owns
 * everything per-agent (status, threads, terminals) and will host more run
 * info later.
 */
export function ChatHeader({
  label,
  isWorkflow,
  status,
  lastActivityAt,
  sidePanelOpen,
  onToggleSidePanel,
}: {
  label: string;
  isWorkflow: boolean;
  status: ChatRunStatus;
  lastActivityAt: string;
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
        <span className="flex shrink-0 items-center gap-1 text-xs">
          <RunStatusIcon status={status} />
          <span className={RUN_STATUS_META[status].className}>{status}</span>
        </span>
        {status !== 'running' ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            · {formatRelativeTime(lastActivityAt)}
          </span>
        ) : null}
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

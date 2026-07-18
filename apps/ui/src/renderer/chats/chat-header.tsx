import { FolderOpen, PanelRight, Workflow as WorkflowIcon } from 'lucide-react';

import type { ChatRunStatus } from '../../shared/contracts';
import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';
import { formatRelativeTime } from './relative-time';
import { RUN_STATUS_META, RunStatusIcon } from './run-status';

/**
 * The open transcript's header: the same identity the sidebar row carries —
 * label, live status (spinning while running), last activity — plus the run's
 * working directory. On the right, a single generic side-panel toggle (the
 * panel hosts the run's agents today and more run info later) and `children`,
 * the slot for run-specific actions (the terminal buttons).
 */
export function ChatHeader({
  label,
  isWorkflow,
  status,
  lastActivityAt,
  cwd,
  sidePanelOpen,
  onToggleSidePanel,
  children,
}: {
  label: string;
  isWorkflow: boolean;
  status: ChatRunStatus;
  lastActivityAt: string;
  cwd: string | null;
  sidePanelOpen: boolean;
  onToggleSidePanel: () => void;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border bg-card/60 px-4 py-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
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
        {cwd ? (
          <span
            className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
            title={cwd}>
            <FolderOpen aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate">{cwd}</span>
          </span>
        ) : null}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {children}
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

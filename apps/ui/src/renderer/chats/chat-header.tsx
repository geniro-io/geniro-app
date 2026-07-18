import { FolderOpen, Users, Workflow as WorkflowIcon } from 'lucide-react';

import type { ChatRunStatus } from '../../shared/contracts';
import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';
import type { AgentDisplay } from './agent-activity';
import { formatRelativeTime } from './relative-time';
import { RUN_STATUS_META, RunStatusIcon } from './run-status';

/** How many agent chips the header shows before collapsing into "+N". */
const MAX_HEADER_AGENTS = 3;

/**
 * The open transcript's header: the same identity the sidebar row carries —
 * label, live status (spinning while running), last activity — plus the run's
 * working directory, and the run's agents as chips. Working agents surface
 * first; at most {@link MAX_HEADER_AGENTS} chips show, the rest collapse into
 * a "+N" chip, and every agent affordance opens the agents panel. `children`
 * is the slot for run-specific actions (the terminal buttons).
 */
export function ChatHeader({
  label,
  isWorkflow,
  status,
  lastActivityAt,
  cwd,
  agents,
  agentsPanelOpen,
  onToggleAgents,
  children,
}: {
  label: string;
  isWorkflow: boolean;
  status: ChatRunStatus;
  lastActivityAt: string;
  cwd: string | null;
  agents: AgentDisplay[];
  agentsPanelOpen: boolean;
  onToggleAgents: () => void;
  children?: React.ReactNode;
}): React.JSX.Element {
  // Working agents first, so the visible chips are the ones doing something.
  const ordered = [...agents].sort((a, b) => b.activeTurns - a.activeTurns);
  const shown = ordered.slice(0, MAX_HEADER_AGENTS);
  const overflow = ordered.length - shown.length;
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
        {shown.map((agent) => (
          <button
            key={agent.id}
            type="button"
            title={`${agent.name} — ${agent.status}${agent.activeTurns > 1 ? ` (${agent.activeTurns} parallel turns)` : ''}`}
            aria-label={`Agent ${agent.name}: ${agent.status}`}
            onClick={onToggleAgents}
            className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs transition-colors hover:bg-accent">
            <RunStatusIcon status={agent.status} />
            <span className="max-w-28 truncate font-medium">{agent.name}</span>
            {agent.activeTurns > 1 ? (
              <span className="rounded-full bg-primary/15 px-1.5 font-semibold text-primary">
                ×{agent.activeTurns}
              </span>
            ) : null}
          </button>
        ))}
        {overflow > 0 ? (
          <button
            type="button"
            aria-label={`Show all ${agents.length} agents`}
            title={`${overflow} more agent${overflow > 1 ? 's' : ''}`}
            onClick={onToggleAgents}
            className="flex items-center rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent">
            +{overflow}
          </button>
        ) : null}
        {agents.length > 0 ? (
          <Button
            type="button"
            variant={agentsPanelOpen ? 'secondary' : 'ghost'}
            size="icon"
            className={cn(
              'size-7',
              !agentsPanelOpen && 'text-muted-foreground',
            )}
            aria-label={
              agentsPanelOpen ? 'Close agents panel' : 'Open agents panel'
            }
            title="Agents"
            onClick={onToggleAgents}>
            <Users className="size-4 shrink-0" />
          </Button>
        ) : null}
        {children}
      </div>
    </div>
  );
}

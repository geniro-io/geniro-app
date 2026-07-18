import { X } from 'lucide-react';

import { PanelResizeHandle, usePanelWidth } from '../components/panel-resize';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { type AgentDisplay, formatTokens, formatUsd } from './agent-activity';
import { RUN_STATUS_META, RunStatusIcon } from './run-status';

/**
 * The right agents sidebar (opened from the transcript header): every agent
 * of the active run with its live status, how many turns it is running in
 * parallel, its current context footprint, and its cumulative spend.
 * Resizable like the builder's side panels.
 */
export function AgentsPanel({
  agents,
  onClose,
}: {
  agents: AgentDisplay[];
  onClose: () => void;
}): React.JSX.Element {
  const { width, startResize } = usePanelWidth({
    storageKey: 'chats.agentsPanelWidth',
    defaultWidth: 280,
    minWidth: 220,
    maxWidth: 420,
    handleEdge: 'left',
  });
  return (
    <aside
      className="relative flex min-h-0 flex-col border-l border-border bg-sidebar"
      style={{ width }}
      aria-label="Run agents">
      <PanelResizeHandle
        edge="left"
        label="Resize agents panel"
        onMouseDown={startResize}
      />
      <div className="flex items-center justify-between py-1.5 pr-2 pl-3">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Agents
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Close agents panel"
          title="Close"
          onClick={onClose}>
          <X className="size-4 shrink-0" />
        </Button>
      </div>
      <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-1.5 overflow-y-auto p-3 pt-1">
        {agents.length === 0 ? (
          <li className="px-2 py-1.5 text-sm text-muted-foreground">
            No agents in this run
          </li>
        ) : (
          agents.map((agent) => (
            <li
              key={agent.id}
              className="flex flex-col gap-1 rounded-lg border border-border bg-card px-2.5 py-2 shadow-panel-sm">
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {agent.name}
                </span>
                {agent.agent ? (
                  <Badge variant="muted">{agent.agent}</Badge>
                ) : null}
              </div>
              <div className="flex items-center gap-1 text-xs">
                <RunStatusIcon status={agent.status} />
                <span className={RUN_STATUS_META[agent.status].className}>
                  {agent.status}
                </span>
                {agent.activeTurns > 1 ? (
                  <span className="text-muted-foreground">
                    · {agent.activeTurns} parallel turns
                  </span>
                ) : null}
              </div>
              {agent.contextTokens !== null || agent.spentUsd !== null ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {agent.contextTokens !== null ? (
                    <span title="Context of the latest turn">
                      ctx {formatTokens(agent.contextTokens)}
                    </span>
                  ) : null}
                  {agent.spentUsd !== null ? (
                    <span title="Total spend across this run's turns">
                      {formatUsd(agent.spentUsd)}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))
        )}
      </ul>
    </aside>
  );
}

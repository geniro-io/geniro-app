import { ChevronRight, Terminal as TerminalIcon, X } from 'lucide-react';
import { useState } from 'react';

import { PanelResizeHandle, usePanelWidth } from '../components/panel-resize';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { ProgressRing } from '../components/ui/progress-ring';
import { cn } from '../components/ui/utils';
import {
  type AgentDisplay,
  type AgentThread,
  CONTEXT_WINDOW_TOKENS,
  formatTokens,
  formatUsd,
} from './agent-activity';
import { RUN_STATUS_META, RunStatusIcon } from './run-status';

/**
 * The right side panel (opened from the transcript header): every agent of
 * the active run with its live status, active/total thread counts, context
 * fill, and spend. Clicking an agent expands its full thread list — the main
 * conversation plus every `call_agent` thread — each openable in a terminal
 * (claude only; a call thread needs its recorded session id, so it opens once
 * settled). Resizable like the builder's side panels.
 */
export function AgentsPanel({
  agents,
  onOpenThread,
  onClose,
}: {
  agents: AgentDisplay[];
  /** Open a terminal mirroring one thread of one agent. */
  onOpenThread: (agent: AgentDisplay, thread: AgentThread) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { width, minWidth, maxWidth, startResize, resizeTo } = usePanelWidth({
    storageKey: 'chats.agentsPanelWidth',
    defaultWidth: 280,
    minWidth: 220,
    maxWidth: 420,
    handleEdge: 'left',
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (agentId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(agentId)) {
        next.add(agentId);
      }
      return next;
    });
  };
  return (
    <aside
      className="relative flex min-h-0 flex-col border-l border-border bg-sidebar"
      style={{ width }}
      aria-label="Run agents">
      <PanelResizeHandle
        edge="left"
        label="Resize agents panel"
        onMouseDown={startResize}
        value={width}
        min={minWidth}
        max={maxWidth}
        onResize={resizeTo}
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
          agents.map((agent) => {
            const fraction =
              agent.contextTokens !== null
                ? agent.contextTokens / CONTEXT_WINDOW_TOKENS
                : null;
            const isExpanded = expanded.has(agent.id);
            return (
              <li
                key={agent.id}
                className="flex flex-col rounded-lg border border-border bg-card shadow-panel-sm">
                <button
                  type="button"
                  className="flex flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent/50"
                  aria-expanded={isExpanded}
                  aria-label={`${agent.name} threads`}
                  onClick={() => toggleExpanded(agent.id)}>
                  <span className="flex items-center gap-1.5">
                    <ChevronRight
                      aria-hidden="true"
                      className={cn(
                        'size-3.5 shrink-0 text-muted-foreground transition-transform',
                        isExpanded && 'rotate-90',
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {agent.name}
                    </span>
                    {agent.agent ? (
                      <Badge variant="muted">{agent.agent}</Badge>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-1 text-xs">
                    <RunStatusIcon status={agent.status} />
                    <span className={RUN_STATUS_META[agent.status].className}>
                      {agent.status}
                    </span>
                    {agent.threads.length > 0 ? (
                      <span className="text-muted-foreground">
                        · {agent.activeTurns} active · {agent.threads.length}{' '}
                        {agent.threads.length === 1 ? 'thread' : 'threads'}
                      </span>
                    ) : null}
                  </span>
                  {fraction !== null || agent.spentUsd !== null ? (
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      {agent.contextTokens !== null ? (
                        <span title="Context of the latest turn / the model's window">
                          ctx {formatTokens(agent.contextTokens)} /{' '}
                          {formatTokens(CONTEXT_WINDOW_TOKENS)}
                        </span>
                      ) : null}
                      {agent.spentUsd !== null ? (
                        <span title="Total spend across this run's turns">
                          {formatUsd(agent.spentUsd)}
                        </span>
                      ) : null}
                      {fraction !== null ? (
                        <ProgressRing
                          fraction={fraction}
                          label={`Context ${Math.round(fraction * 100)}% full`}
                          className={cn(
                            'ml-auto',
                            fraction >= 0.9
                              ? 'text-destructive'
                              : fraction >= 0.7
                                ? 'text-warning'
                                : 'text-primary',
                          )}
                        />
                      ) : null}
                    </span>
                  ) : null}
                </button>
                {isExpanded ? (
                  <ul className="m-0 flex list-none flex-col gap-0.5 border-t border-border px-2 py-1.5">
                    {agent.threads.length === 0 ? (
                      <li className="px-1 py-1 text-xs text-muted-foreground">
                        No threads yet
                      </li>
                    ) : (
                      agent.threads.map((thread) => {
                        // Only claude has an interactive mirror; a call thread
                        // additionally needs its recorded session id (settled).
                        const canOpen =
                          agent.agent === 'claude' &&
                          (thread.kind === 'main' || thread.sessionId !== null);
                        return (
                          <li
                            key={thread.id}
                            className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs">
                            <RunStatusIcon status={thread.status} />
                            <span
                              className="min-w-0 flex-1 truncate"
                              title={thread.label}>
                              {thread.label}
                            </span>
                            {canOpen ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="size-6 shrink-0 text-muted-foreground"
                                aria-label={`Open terminal for ${agent.name} — ${thread.id}`}
                                title="Open a terminal on this thread"
                                onClick={() => onOpenThread(agent, thread)}>
                                <TerminalIcon className="size-3.5 shrink-0" />
                              </Button>
                            ) : null}
                          </li>
                        );
                      })
                    )}
                  </ul>
                ) : null}
              </li>
            );
          })
        )}
      </ul>
    </aside>
  );
}

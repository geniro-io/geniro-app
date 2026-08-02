import { ChevronRight, Terminal as TerminalIcon, X } from 'lucide-react';
import { useState } from 'react';

import { PanelResizeHandle, usePanelWidth } from '../components/panel-resize';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';
import { type AgentDisplay, type AgentThread } from './agent-activity';
import { ContextMeter } from './context-meter';
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
            const isExpanded = expanded.has(agent.id);
            // An agent whose only thread is its own conversation has nothing
            // to expand INTO — the card already is that conversation. Showing
            // a chevron over a one-row list (the 1:1 chat's whole shape) is
            // pure nesting, so the levels collapse and the terminal button
            // moves up onto the card itself.
            const soleThread =
              agent.threads.length === 1 && agent.threads[0]?.kind === 'main'
                ? agent.threads[0]
                : null;
            const soleThreadTerminal =
              soleThread !== null && agent.agent === 'claude'
                ? soleThread
                : null;
            const Header = soleThread ? 'div' : 'button';
            return (
              <li
                key={agent.id}
                className="flex flex-col rounded-lg border border-border bg-card shadow-panel-sm">
                <Header
                  {...(soleThread
                    ? {}
                    : {
                        type: 'button' as const,
                        'aria-expanded': isExpanded,
                        'aria-label': `${agent.name} threads`,
                        onClick: () => toggleExpanded(agent.id),
                      })}
                  className={cn(
                    'flex flex-col gap-1 rounded-lg px-2.5 py-2 text-left',
                    !soleThread && 'transition-colors hover:bg-accent/50',
                  )}>
                  <span className="flex items-center gap-1.5">
                    {soleThread ? null : (
                      <ChevronRight
                        aria-hidden="true"
                        className={cn(
                          'size-3.5 shrink-0 text-muted-foreground transition-transform',
                          isExpanded && 'rotate-90',
                        )}
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {agent.name}
                    </span>
                    {agent.agent ? (
                      <Badge variant="muted">{agent.agent}</Badge>
                    ) : null}
                    {soleThreadTerminal ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-6 shrink-0 text-muted-foreground"
                        aria-label={`Open terminal for ${agent.name}`}
                        title="Open a terminal on this conversation"
                        onClick={() => onOpenThread(agent, soleThreadTerminal)}>
                        <TerminalIcon className="size-3.5 shrink-0" />
                      </Button>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-1 text-xs">
                    <RunStatusIcon status={agent.status} />
                    <span className={RUN_STATUS_META[agent.status].className}>
                      {agent.status}
                    </span>
                    {agent.threads.length > 0 && soleThread === null ? (
                      <span className="text-muted-foreground">
                        · {agent.activeTurns} active · {agent.threads.length}{' '}
                        {agent.threads.length === 1 ? 'thread' : 'threads'}
                      </span>
                    ) : soleThread !== null && agent.activeTurns > 0 ? (
                      // The thread COUNT is noise when there is only one, but
                      // how many turns are live on it is not — an agent can
                      // run several at once on its own conversation.
                      <span className="text-muted-foreground">
                        · {agent.activeTurns} active
                      </span>
                    ) : null}
                  </span>
                  <ContextMeter
                    contextTokens={agent.contextTokens}
                    contextWindowTokens={agent.contextWindowTokens}
                    spentUsd={agent.spentUsd}
                  />
                </Header>
                {isExpanded && soleThread === null ? (
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

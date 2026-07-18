import { Pencil, Workflow as WorkflowIcon } from 'lucide-react';

import type { ChatRunStatus } from '../../shared/contracts';
import { NavListItem } from '../components/nav-list-item';
import { Button } from '../components/ui/button';
import { formatRelativeTime } from './relative-time';
import { RUN_STATUS_META, RunStatusIcon } from './run-status';

/**
 * One chat-list row: the run's label (custom title, else its workflow's name,
 * else the agent), a hover-revealed rename control, the latest message as a
 * one-line preview, and a status line — icon + tone per state, spinning while
 * running — with the last-activity time on the right (hidden while running:
 * the spinner IS the live signal).
 */
export function ChatListItem({
  label,
  isWorkflow,
  status,
  lastMessage,
  lastActivityAt,
  active,
  onActivate,
  onRename,
}: {
  label: string;
  /** Show the workflow glyph before the label (a team run, not a 1:1 chat). */
  isWorkflow: boolean;
  status: ChatRunStatus;
  lastMessage: string | null;
  /** ISO time of the run's last activity (its `updatedAt`). */
  lastActivityAt: string;
  active: boolean;
  onActivate: () => void;
  onRename: () => void;
}): React.JSX.Element {
  const meta = RUN_STATUS_META[status];
  return (
    <NavListItem active={active} className="group" onActivate={onActivate}>
      <span className="flex items-center gap-1.5">
        {isWorkflow ? (
          <WorkflowIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {label}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={`Rename ${label}`}
          title="Rename"
          onClick={(event) => {
            event.stopPropagation();
            onRename();
          }}>
          <Pencil className="size-3 shrink-0" />
        </Button>
      </span>
      {lastMessage ? (
        <span className="truncate text-xs text-muted-foreground">
          {lastMessage}
        </span>
      ) : null}
      <span className="flex items-center gap-1 text-xs">
        <RunStatusIcon status={status} />
        <span className={meta.className}>{status}</span>
        {status !== 'running' ? (
          <span className="ml-auto pl-2 text-muted-foreground">
            {formatRelativeTime(lastActivityAt)}
          </span>
        ) : null}
      </span>
    </NavListItem>
  );
}

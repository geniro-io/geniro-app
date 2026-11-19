import {
  Bot,
  CircleCheck,
  Folder,
  GitPullRequest,
  Inbox,
  type LucideIcon,
  RotateCw,
  Send,
  Users,
} from 'lucide-react';
import { memo } from 'react';

import { ClampedText } from '../components/clamped-text';
import { ThreadLabelChip } from '../components/thread-labels';
import { PALETTE_BORDER_CLASS } from '../components/ui/palette';
import { PaletteDot } from '../components/ui/palette-dot';
import { cn } from '../components/ui/utils';
import { plainPreview } from './brief-text';
import {
  sentOutcomeWords,
  type ThreadMessageRow,
} from './thread-message-payload';
import { ThreadTitle, useThreadIdentity } from './thread-title';

/** What happened between this thread and another one. */
export type ThreadEventKind = 'sent' | 'received' | 'woken' | 'done';

const KIND_META: Record<ThreadEventKind, { icon: LucideIcon; label: string }> =
  {
    sent: { icon: Send, label: 'Message to' },
    received: { icon: Inbox, label: 'Message from' },
    woken: { icon: RotateCw, label: 'Woken by a message from' },
    done: { icon: CircleCheck, label: 'Done' },
  };

export interface ThreadEventCardProps {
  kind: ThreadEventKind;
  /** The other thread. */
  runId: string;
  /** Its title as the row recorded it, drawn where the view does not know the thread. */
  title: string;
  text?: string | null;
  /** The member of a team thread who sent the message. */
  member?: string | null;
  /** The message of this thread the received one answers. */
  inReplyTo?: string | null;
  /** What became of a sent message, in words. */
  outcome?: string | null;
  /** The manager's short name for the thread (`t22`). */
  handle?: string | null;
  pullRequest?: number | null;
}

/**
 * One event between this thread and another — a message sent or received, a
 * turn a message started, a thread that finished — headed by that thread the
 * way the command center's canvas shows it, in its project's colour where the
 * view knows it.
 */
export const ThreadEventCard = memo(function ThreadEventCard({
  kind,
  runId,
  title,
  text = null,
  member = null,
  inReplyTo = null,
  outcome = null,
  handle = null,
  pullRequest = null,
}: ThreadEventCardProps): React.JSX.Element {
  const identity = useThreadIdentity(runId);
  const meta = KIND_META[kind];
  const Icon = meta.icon;
  const color = identity?.projectColor ?? null;
  const reply = inReplyTo === null ? '' : plainPreview(inReplyTo);
  return (
    <article
      data-slot="thread-event-card"
      data-kind={kind}
      data-run={runId}
      data-color={color ?? undefined}
      className={cn(
        'flex w-full min-w-0 flex-col gap-1.5 self-start rounded-xl border border-l-4 border-border bg-card px-3.5 py-2.5 text-sm',
        color === null ? 'border-l-primary/50' : PALETTE_BORDER_CLASS[color],
      )}>
      <header className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        <Icon
          aria-hidden="true"
          className={cn('size-3.5 shrink-0', kind === 'done' && 'text-success')}
        />
        <span data-slot="thread-event-label" className="shrink-0">
          {meta.label}
        </span>
        {handle === null ? null : (
          <span
            data-slot="thread-event-handle"
            className="shrink-0 font-mono text-foreground/80">
            {handle}
          </span>
        )}
        <ThreadTitle runId={runId} title={identity?.title ?? title} chip />
        {member === null ? null : (
          <span data-slot="thread-event-member" className="shrink-0">
            · {member}
          </span>
        )}
        {identity?.agentLabel == null ? null : (
          <ThreadLabelChip
            slot="thread-event-agent"
            icon={identity.isTeam ? Users : Bot}
            text={identity.agentLabel}
            title={
              identity.isTeam
                ? `Team ${identity.agentLabel}`
                : `Agent ${identity.agentLabel}`
            }
            yields={false}
          />
        )}
        {identity?.project == null ? null : (
          <ThreadLabelChip
            slot="thread-event-project"
            icon={Folder}
            mark={
              color === null ? undefined : (
                <PaletteDot
                  color={color}
                  size="md"
                  data-slot="thread-event-project-dot"
                />
              )
            }
            text={identity.project}
            title={`Project ${identity.project}`}
            yields={false}
          />
        )}
        {pullRequest === null ? null : (
          <ThreadLabelChip
            slot="thread-event-pull-request"
            icon={GitPullRequest}
            text={`#${pullRequest}`}
            title={`Pull request #${pullRequest}`}
            yields={false}
          />
        )}
      </header>
      {reply === '' ? null : (
        <blockquote
          data-slot="thread-event-reply-to"
          title={reply}
          className="flex min-w-0 flex-col gap-0.5 border-l-2 border-border pl-2 text-xs text-muted-foreground">
          <span className="shrink-0 font-medium">In reply to your message</span>
          <span className="min-w-0 truncate italic">{reply}</span>
        </blockquote>
      )}
      {text === null || text === '' ? null : (
        <ClampedText
          text={text}
          lines={3}
          slot="thread-event-text"
          className="text-sm text-foreground"
        />
      )}
      {outcome === null ? null : (
        <p
          data-slot="thread-event-outcome"
          className="text-xs text-muted-foreground">
          {outcome}
        </p>
      )}
    </article>
  );
});

/** A transcript row about another thread, drawn as its event cards. */
export function ThreadEventRow({
  row,
}: {
  row: ThreadMessageRow;
}): React.JSX.Element {
  switch (row.kind) {
    case 'received':
      return (
        <ThreadEventStack>
          {row.messages.map((message) => (
            <ThreadEventCard
              key={message.id}
              kind="received"
              runId={message.fromRunId}
              title={message.fromTitle}
              member={message.fromMember}
              inReplyTo={message.inReplyTo?.text ?? null}
              text={message.text}
            />
          ))}
        </ThreadEventStack>
      );
    case 'woken':
      return (
        <ThreadEventCard
          kind="woken"
          runId={row.fromRunId}
          title={row.fromTitle}
        />
      );
    case 'sent':
      return (
        <ThreadEventCard
          kind="sent"
          runId={row.sent.toRunId}
          title={row.sent.title}
          text={row.sent.text}
          outcome={sentOutcomeWords(row.sent)}
        />
      );
    case 'done':
      return (
        <ThreadEventStack>
          {row.done.map((done) => (
            <ThreadEventCard
              key={done.runId}
              kind="done"
              runId={done.runId}
              title={done.title}
              handle={done.handle}
              text={done.summary}
              pullRequest={done.pullRequest}
            />
          ))}
        </ThreadEventStack>
      );
  }
}

function ThreadEventStack({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      data-slot="thread-event-stack"
      className="flex w-full min-w-0 flex-col gap-1.5">
      {children}
    </div>
  );
}

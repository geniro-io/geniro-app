import {
  CircleCheck,
  CornerDownRight,
  Inbox,
  type LucideIcon,
  Reply,
  RotateCw,
  Send,
} from 'lucide-react';
import { memo, useContext } from 'react';

import {
  ArchiveThreadButton,
  ArchiveThreadIcon,
  useThreadArchive,
} from '../components/thread-archive';
import {
  bareThreadIdentity,
  ThreadHead,
  type ThreadIdentity,
} from '../components/thread-head';
import { cn } from '../components/ui/utils';
import { plainPreview } from './brief-text';
import { ClampedMarkdown } from './clamped-markdown';
import {
  sentOutcomeWords,
  type ThreadMessageRow,
} from './thread-message-payload';
import { ThreadOpenContext, useThreadIdentity } from './thread-title';

/** What happened between this thread and another one. */
export type ThreadEventKind = 'sent' | 'received' | 'woken' | 'done';

const KIND_META: Record<
  ThreadEventKind,
  { icon: LucideIcon; label: string; rail: string }
> = {
  sent: { icon: Send, label: 'Message to', rail: 'border-primary/40' },
  received: { icon: Inbox, label: 'Message from', rail: 'border-border' },
  woken: {
    icon: RotateCw,
    label: 'Woken by a message from',
    rail: 'border-border',
  },
  done: { icon: CircleCheck, label: 'Done', rail: 'border-success/50' },
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
  /** Where the text's Show more is remembered within the thread. */
  memoryKey?: string;
}

function identityOf(
  known: ThreadIdentity | null,
  title: string,
  pullRequest: number | null,
): ThreadIdentity {
  const identity = known ?? bareThreadIdentity(title);
  return identity.pullRequest !== null || pullRequest === null
    ? identity
    : { ...identity, pullRequest: { number: pullRequest, state: null } };
}

/**
 * One event between this thread and another — a message sent or received, a
 * turn a message started, a thread that finished — headed by that thread the
 * way the command center's graph shows it: its face, title, pull request and
 * labels where the view knows it, its recorded title alone where it does not.
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
  memoryKey,
}: ThreadEventCardProps): React.JSX.Element {
  const known = useThreadIdentity(runId);
  const open = useContext(ThreadOpenContext);
  const archive = useThreadArchive(runId);
  const identity = identityOf(known, title, pullRequest);
  const meta = KIND_META[kind];
  const Icon = meta.icon;
  const reply = inReplyTo === null ? '' : plainPreview(inReplyTo);
  return (
    <article
      data-slot="thread-event-card"
      data-kind={kind}
      data-run={runId}
      data-color={identity.projectColor ?? undefined}
      className="flex w-full max-w-2xl min-w-0 flex-col gap-2 self-start rounded-lg border border-border/70 bg-card px-3 py-2.5 text-sm">
      <p className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
        <Icon
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0',
            kind === 'done' ? 'text-success' : 'text-muted-foreground',
          )}
        />
        <span data-slot="thread-event-label" className="shrink-0 font-medium">
          {meta.label}
        </span>
        {handle === null ? null : (
          <span
            data-slot="thread-event-handle"
            className="shrink-0 rounded-sm bg-muted px-1 font-mono text-foreground/80">
            {handle}
          </span>
        )}
        {member === null ? null : (
          <span data-slot="thread-event-member" className="min-w-0 truncate">
            · {member}
          </span>
        )}
      </p>
      <ThreadHead
        identity={identity}
        slot="thread-event"
        onOpen={open === null ? undefined : () => open(runId)}
        aside={
          archive === null ? undefined : (
            <ArchiveThreadIcon title={identity.title} onArchive={archive} />
          )
        }
      />
      {reply === '' ? null : (
        <p
          data-slot="thread-event-reply-to"
          title={reply}
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Reply aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="shrink-0">In reply to your message</span>
          <span className="min-w-0 truncate italic">{reply}</span>
        </p>
      )}
      {text === null || text === '' ? null : (
        <div className={cn('border-l-2 pl-3', meta.rail)}>
          <ClampedMarkdown
            text={text}
            lines={8}
            slot="thread-event-text"
            className="text-sm text-foreground"
            toggleClassName="text-xs"
            memoryKey={memoryKey}
          />
        </div>
      )}
      {archive === null || kind !== 'done' ? null : (
        <div className="flex justify-end">
          <ArchiveThreadButton
            slot="thread-event-archive"
            title={identity.title}
            onArchive={archive}
          />
        </div>
      )}
      {outcome === null ? null : (
        <p
          data-slot="thread-event-outcome"
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <CornerDownRight aria-hidden="true" className="size-3.5 shrink-0" />
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
              memoryKey={`thread-event:${message.id}`}
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

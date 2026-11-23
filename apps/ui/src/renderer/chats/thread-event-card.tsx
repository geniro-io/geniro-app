import { MessageSquare, Reply } from 'lucide-react';
import { memo, useContext } from 'react';

import {
  ArchiveThreadButton,
  ArchiveThreadIcon,
  useThreadArchive,
} from '../components/thread-archive';
import {
  bareThreadIdentity,
  ThreadActionButton,
  type ThreadIdentity,
} from '../components/thread-head';
import {
  AgentEventCard,
  AgentEventStack,
  type ThreadEventKind,
} from './agent-event-card';
import { plainPreview } from './brief-text';
import {
  sentOutcomeWords,
  type ThreadMessageRow,
} from './thread-message-payload';
import { ThreadOpenContext, useThreadIdentity } from './thread-title';

export type { ThreadEventKind } from './agent-event-card';

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
  const reply = inReplyTo === null ? '' : plainPreview(inReplyTo);
  return (
    <AgentEventCard
      kind={kind}
      slot="thread-event"
      identity={identity}
      handle={handle}
      member={member}
      onOpen={open === null ? undefined : () => open(runId)}
      headAside={
        archive === null ? undefined : (
          <ArchiveThreadIcon title={identity.title} onArchive={archive} />
        )
      }
      lead={
        reply === '' ? null : (
          <p
            data-slot="thread-event-reply-to"
            title={reply}
            className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Reply aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="shrink-0">In reply to your message</span>
            <span className="min-w-0 truncate italic">{reply}</span>
          </p>
        )
      }
      text={text}
      memoryKey={memoryKey}
      actions={
        kind !== 'done' || (open === null && archive === null) ? null : (
          <>
            {open === null ? null : (
              <ThreadActionButton
                slot="thread-event-open"
                label={`Open ${identity.title}`}
                title="Open this thread's chat"
                icon={<MessageSquare aria-hidden="true" />}
                onClick={() => open(runId)}>
                Open chat
              </ThreadActionButton>
            )}
            {archive === null ? null : (
              <ArchiveThreadButton
                slot="thread-event-archive"
                title={identity.title}
                onArchive={archive}
              />
            )}
          </>
        )
      }
      outcome={outcome === null ? null : { text: outcome }}
      data={{
        'data-run': runId,
        'data-color': identity.projectColor ?? undefined,
      }}
    />
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
    <AgentEventStack slot="thread-event-stack">{children}</AgentEventStack>
  );
}

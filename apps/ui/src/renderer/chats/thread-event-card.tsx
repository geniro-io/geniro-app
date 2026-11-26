import { ChevronDown, MessageSquare, Reply, X } from 'lucide-react';
import { memo, useContext } from 'react';

import {
  ArchivedThreadBadge,
  ArchiveThreadButton,
  ArchiveThreadIcon,
  UnarchiveThreadButton,
  useThreadArchive,
  useThreadUnarchive,
} from '../components/thread-archive';
import {
  bareThreadIdentity,
  ThreadActionButton,
  ThreadFoot,
  type ThreadIdentity,
} from '../components/thread-head';
import {
  AgentEventCard,
  AgentEventStack,
  type ThreadEventKind,
} from './agent-event-card';
import { plainPreview } from './brief-text';
import { ChatLink } from './browser/chat-link';
import {
  isNewestDone,
  ThreadArchivedContext,
  ThreadDoneNewestContext,
  ThreadReportsContext,
} from './thread-done-context';
import {
  sentOutcomeWords,
  type ThreadMessageRow,
} from './thread-message-payload';
import { ThreadOpenContext, useThreadIdentity } from './thread-title';
import { useThreadFlag } from './thread-ui-memory';

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
  /** When the row was written, which a Done card's foot dates it by. */
  at?: string | null;
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
    : {
        ...identity,
        pullRequest: { number: pullRequest, state: null, url: null },
      };
}

function linkPullRequest(url: string, label: React.ReactNode): React.ReactNode {
  return (
    <ChatLink
      href={url}
      data-slot="thread-event-pull-request-link"
      className="shrink-0 rounded-sm outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring">
      {label}
    </ChatLink>
  );
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
  at = null,
  memoryKey,
}: ThreadEventCardProps): React.JSX.Element {
  const known = useThreadIdentity(runId);
  const open = useContext(ThreadOpenContext);
  const archive = useThreadArchive(runId);
  const unarchive = useThreadUnarchive(runId);
  const archivedMap = useContext(ThreadArchivedContext);
  const archived =
    kind === 'done' && (archivedMap?.get(runId) ?? null) !== null;
  const reports = useContext(ThreadReportsContext);
  const [hidden, setHidden] = useThreadFlag(
    kind === 'done' ? `thread-done-hidden:${runId}` : undefined,
    false,
  );
  const identity = identityOf(known, title, pullRequest);
  const reply = inReplyTo === null ? '' : plainPreview(inReplyTo);
  if (kind === 'done' && hidden) {
    return (
      <AgentEventCard
        kind="done"
        slot="thread-event"
        line={
          <p
            data-slot="thread-event-dismissed"
            className="flex min-w-0 items-center gap-1.5 text-xs leading-5">
            <span className="min-w-0 truncate font-medium text-foreground">
              {identity.title}
            </span>
            <span className="shrink-0 text-muted-foreground">finished</span>
          </p>
        }
        actions={
          <ThreadActionButton
            slot="thread-event-show"
            label={`Show ${identity.title}`}
            title="Show this card again"
            icon={<ChevronDown aria-hidden="true" />}
            onClick={() => setHidden(false)}>
            Show
          </ThreadActionButton>
        }
        data={{ 'data-run': runId }}
      />
    );
  }
  if (archived) {
    return (
      <div data-slot="thread-event-archived" className="opacity-70">
        <AgentEventCard
          kind="done"
          slot="thread-event"
          line={
            <p className="flex min-w-0 items-center gap-1.5 text-xs leading-5">
              <span className="min-w-0 truncate font-medium text-foreground">
                {identity.title}
              </span>
              <ArchivedThreadBadge />
            </p>
          }
          actions={
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
              {unarchive === null ? null : (
                <UnarchiveThreadButton
                  slot="thread-event-unarchive"
                  title={identity.title}
                  onUnarchive={unarchive}
                />
              )}
            </>
          }
          data={{ 'data-run': runId }}
        />
      </div>
    );
  }
  const shownText = kind === 'done' ? (reports?.get(runId) ?? text) : text;
  return (
    <AgentEventCard
      kind={kind}
      slot="thread-event"
      identity={identity}
      handle={handle}
      member={member}
      onOpen={open === null ? undefined : () => open(runId)}
      fullHead={kind === 'done'}
      linkPullRequest={linkPullRequest}
      headAside={
        archive === null || kind === 'done' ? undefined : (
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
      text={shownText}
      memoryKey={memoryKey}
      foot={
        kind !== 'done' ? undefined : (
          <ThreadFoot slot="thread-event" at={at}>
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
            <ThreadActionButton
              slot="thread-event-dismiss"
              label={`Hide ${identity.title}`}
              title="Hide this card"
              icon={<X aria-hidden="true" />}
              onClick={() => setHidden(true)}>
              Dismiss
            </ThreadActionButton>
            {archive === null ? null : (
              <ArchiveThreadButton
                slot="thread-event-archive"
                title={identity.title}
                onArchive={archive}
              />
            )}
          </ThreadFoot>
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
  seq,
  at = null,
}: {
  row: ThreadMessageRow;
  seq?: number;
  /** When the row was written. */
  at?: string | null;
}): React.JSX.Element | null {
  const newest = useContext(ThreadDoneNewestContext);
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
    case 'done': {
      const shown = row.done.filter(
        (done) => seq === undefined || isNewestDone(newest, done.runId, seq),
      );
      if (shown.length === 0) {
        return null;
      }
      return (
        <ThreadEventStack>
          {shown.map((done) => (
            <ThreadEventCard
              key={done.runId}
              kind="done"
              runId={done.runId}
              title={done.title}
              handle={done.handle}
              text={done.summary}
              pullRequest={done.pullRequest}
              at={at}
            />
          ))}
        </ThreadEventStack>
      );
    }
    case 'waiting':
      return null;
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

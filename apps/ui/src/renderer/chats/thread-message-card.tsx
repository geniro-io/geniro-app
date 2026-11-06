import { createContext, useContext } from 'react';

import { ClampedText } from '../components/clamped-text';
import { Card } from '../components/ui/card';
import type { ReceivedThreadMessage } from './thread-message-payload';

/**
 * Opens another thread by its run id, as the sidebar opens one — or null where
 * a thread cannot be opened (a hosted view), so a thread's title is plain text.
 */
export const ThreadOpenContext = createContext<
  ((runId: string) => void) | null
>(null);

/** A thread's title, a press away from that thread where the view can open one. */
export function ThreadTitle({
  runId,
  title,
}: {
  runId: string;
  title: string;
}): React.JSX.Element {
  const open = useContext(ThreadOpenContext);
  if (open === null) {
    return <span className="min-w-0 break-words font-medium">{title}</span>;
  }
  return (
    <button
      type="button"
      data-slot="thread-title"
      title="Open this thread"
      className="min-w-0 cursor-pointer break-words text-left font-medium underline decoration-dotted underline-offset-2 hover:text-primary"
      onClick={() => open(runId)}>
      {title}
    </button>
  );
}

/**
 * The messages another thread sent this one, as the turn that took them shows
 * them: each a card of its own with its sender and its whole text.
 */
export function ThreadMessageCard({
  messages,
}: {
  messages: readonly ReceivedThreadMessage[];
}): React.JSX.Element {
  return (
    <div
      data-slot="thread-message-card"
      className="flex min-w-0 flex-col gap-2">
      {messages.map((message) => (
        <Card
          key={message.id}
          data-slot="thread-message"
          className="flex min-w-0 flex-col gap-1.5 p-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
            <span>Message from</span>{' '}
            <ThreadTitle runId={message.fromRunId} title={message.fromTitle} />
            {message.fromMember === null ? null : (
              <span>· {message.fromMember}</span>
            )}
          </div>
          <ClampedText
            text={message.text}
            lines={4}
            slot="thread-message-text"
            className="text-sm text-foreground"
          />
        </Card>
      ))}
    </div>
  );
}

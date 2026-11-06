import { Send } from 'lucide-react';

import { MessageBubble } from './message-bubble';
import { ThreadTitle } from './thread-message-card';
import {
  threadMessageReasonWords,
  type ThreadMessageSent,
} from './thread-message-payload';

/**
 * A message this thread sent, and what became of it: the thread it went to,
 * a press away, and in words what happened there.
 */
export function ThreadMessageSentRow({
  sent,
}: {
  sent: ThreadMessageSent;
}): React.JSX.Element {
  return (
    <MessageBubble variant="note">
      <span
        data-slot="thread-message-sent"
        data-outcome={sent.outcome}
        className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
        <Send aria-hidden="true" className="size-3 shrink-0" />
        <span>Message to</span>{' '}
        <ThreadTitle runId={sent.toRunId} title={sent.title} />{' '}
        <span>{sentOutcomeWords(sent)}</span>
      </span>
    </MessageBubble>
  );
}

function sentOutcomeWords(sent: ThreadMessageSent): string {
  if (sent.outcome === 'joined') {
    return 'joined the running turn';
  }
  if (sent.outcome === 'woken') {
    return 'started a turn there';
  }
  return sent.reason === null
    ? 'is waiting'
    : threadMessageReasonWords(sent.reason);
}

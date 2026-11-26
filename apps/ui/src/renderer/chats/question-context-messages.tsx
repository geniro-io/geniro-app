import { ChevronUp, History } from 'lucide-react';
import { useContext, useEffect, useRef, useState } from 'react';

import { ThreadActionButton } from '../components/thread-head';
import { useLatestCallback } from '../components/use-latest-callback';
import { ClampedBlock, isLongMarkdown } from './clamped-markdown';
import { MarkdownContent } from './markdown-content';
import {
  type ThreadContextMessage,
  ThreadContextReaderContext,
} from './thread-question-context';

/** The lines the messages before a question may fill before they fold. */
const MESSAGES_LINES = 8;

function messageLabel(role: ThreadContextMessage['role']): string {
  return role === 'user' ? 'Sent to the thread' : 'The thread';
}

function messagesText(messages: ThreadContextMessage[]): string {
  return messages
    .map((message) => `${messageLabel(message.role)}\n${message.text}`)
    .join('\n');
}

type ContextState =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'shown'; messages: ThreadContextMessage[] }
  | { kind: 'failed' };

function ContextMessages({
  state,
  memoryKey,
}: {
  state: Exclude<ContextState, { kind: 'hidden' }>;
  memoryKey: string;
}): React.JSX.Element {
  return (
    <div
      data-slot="thread-question-context"
      data-state={state.kind}
      className="flex w-full min-w-0 flex-col gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-2">
      {state.kind === 'loading' ? (
        <p role="status" className="text-xs text-muted-foreground">
          Reading the thread…
        </p>
      ) : state.kind === 'failed' ? (
        <p className="text-xs text-destructive">
          Could not read the thread’s messages.
        </p>
      ) : state.messages.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          The thread said nothing before this question.
        </p>
      ) : (
        <ClampedBlock
          long={isLongMarkdown(messagesText(state.messages), MESSAGES_LINES)}
          lines={MESSAGES_LINES}
          slot="thread-question-context-messages"
          toggleClassName="text-xs"
          memoryKey={memoryKey}>
          <div className="flex min-w-0 flex-col gap-2">
            {state.messages.map((message) => (
              <div
                key={message.seq}
                data-slot="thread-question-context-message"
                data-role={message.role}
                className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[11px] font-medium text-muted-foreground">
                  {messageLabel(message.role)}
                </span>
                <MarkdownContent content={message.text} className="text-xs" />
              </div>
            ))}
          </div>
        </ClampedBlock>
      )}
    </div>
  );
}

/**
 * The messages a relayed question's thread sent right before it, read as they
 * stand and drawn expanded, with a toggle that folds them and reads them again.
 * Drawn wherever the question is answered: the manager chat's card and the
 * canvas popover. Nothing is drawn where no reader is provided.
 */
export function QuestionContextMessages({
  threadRunId,
  threadRequestId,
}: {
  threadRunId: string;
  /** The question's request id; null reads the thread's newest messages. */
  threadRequestId: string | null;
}): React.JSX.Element | null {
  const readContext = useContext(ThreadContextReaderContext);
  const [context, setContext] = useState<ContextState>({ kind: 'loading' });
  const reading = useRef(0);
  const load = useLatestCallback((): void => {
    if (readContext === null) {
      return;
    }
    const read = (reading.current += 1);
    setContext({ kind: 'loading' });
    readContext(threadRunId, threadRequestId).then(
      (messages) => {
        if (reading.current === read) {
          setContext({ kind: 'shown', messages });
        }
      },
      () => {
        if (reading.current === read) {
          setContext({ kind: 'failed' });
        }
      },
    );
  }, [readContext, threadRunId, threadRequestId]);
  useEffect(() => {
    load();
    return () => {
      reading.current += 1;
    };
  }, [load]);
  if (readContext === null) {
    return null;
  }
  const hidden = context.kind === 'hidden';
  const toggle = (): void => {
    if (hidden) {
      load();
      return;
    }
    reading.current += 1;
    setContext({ kind: 'hidden' });
  };
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <ThreadActionButton
        slot="thread-question-show-context"
        label={
          hidden
            ? 'Show the messages before the question'
            : 'Hide the messages before the question'
        }
        title={
          hidden
            ? 'Show the last few messages of the thread before it asked'
            : 'Hide them'
        }
        icon={
          hidden ? (
            <History aria-hidden="true" />
          ) : (
            <ChevronUp aria-hidden="true" />
          )
        }
        onClick={toggle}>
        {hidden ? 'Show a few messages' : 'Hide messages'}
      </ThreadActionButton>
      {hidden ? null : (
        <ContextMessages
          state={context}
          memoryKey={`question-context:${threadRunId}:${threadRequestId ?? 'latest'}`}
        />
      )}
    </div>
  );
}

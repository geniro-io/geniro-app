import { ChevronUp, History } from 'lucide-react';
import { useContext, useEffect, useRef, useState } from 'react';

import { ThreadActionButton } from '../components/thread-head';
import { useLatestCallback } from '../components/use-latest-callback';
import { ClampedBlock, isLongMarkdown } from './clamped-markdown';
import { MarkdownContent } from './markdown-content';
import { QuestionAttachments } from './question-attachments';
import type { QuestionAttachmentSet } from './question-attachments-payload';
import { QuestionContextVisual } from './question-context-visual';
import {
  isThreadContextVisual,
  type ThreadContextEntry,
  type ThreadContextMessage,
  ThreadContextReaderContext,
} from './thread-question-context';
import { ThreadRunBindings } from './thread-run-bindings';

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
  | { kind: 'shown'; entries: ThreadContextEntry[] }
  | { kind: 'failed' };

/**
 * The messages fold under one Show more. The pages and pictures of a question
 * that carries no attachments stand beside them, never under the fold, since
 * they are what the question may point at.
 */
function ContextMessages({
  state,
  memoryKey,
  showVisuals,
}: {
  state: Exclude<ContextState, { kind: 'hidden' }>;
  memoryKey: string;
  showVisuals: boolean;
}): React.JSX.Element {
  const entries = state.kind === 'shown' ? state.entries : [];
  const messages = entries.filter(
    (entry): entry is ThreadContextMessage => !isThreadContextVisual(entry),
  );
  const visuals = showVisuals ? entries.filter(isThreadContextVisual) : [];
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
      ) : entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          The thread said nothing before this question.
        </p>
      ) : (
        <>
          {messages.length === 0 ? null : (
            <ClampedBlock
              long={isLongMarkdown(messagesText(messages), MESSAGES_LINES)}
              lines={MESSAGES_LINES}
              slot="thread-question-context-messages"
              toggleClassName="text-xs"
              memoryKey={memoryKey}>
              <div className="flex min-w-0 flex-col gap-2">
                {messages.map((message) => (
                  <div
                    key={message.seq}
                    data-slot="thread-question-context-message"
                    data-role={message.role}
                    className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {messageLabel(message.role)}
                    </span>
                    <MarkdownContent
                      content={message.text}
                      className="text-xs"
                    />
                  </div>
                ))}
              </div>
            </ClampedBlock>
          )}
          {visuals.map((visual) => (
            <QuestionContextVisual key={visual.seq} entry={visual} />
          ))}
        </>
      )}
    </div>
  );
}

/**
 * The messages a relayed question's thread sent right before it, read as they
 * stand and drawn expanded, with a toggle that folds them and reads them again.
 * Drawn wherever the question is answered: the manager chat's card and the
 * canvas popover. Nothing is drawn where no reader is provided.
 *
 * A question row that carries `attachments` draws exactly those pages and
 * pictures, beneath the toggle and never folded with it. A question without the
 * key predates them, and keeps the pages its asking turn showed, read from the
 * thread. The pages are bound to the thread's run: what the user picks on a
 * page is kept for the thread, and no page is shared from here.
 */
export function QuestionContextMessages({
  threadRunId,
  threadRequestId,
  attachments,
}: {
  threadRunId: string;
  /** The question's request id; null reads the thread's newest messages. */
  threadRequestId: string | null;
  /** Undefined for a question written before attachments existed. */
  attachments?: QuestionAttachmentSet;
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
    readContext.read(threadRunId, threadRequestId).then(
      (entries) => {
        if (reading.current === read) {
          setContext({ kind: 'shown', entries });
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
        <ThreadRunBindings reader={readContext} threadRunId={threadRunId}>
          <ContextMessages
            state={context}
            memoryKey={`question-context:${threadRunId}:${threadRequestId ?? 'latest'}`}
            showVisuals={attachments === undefined}
          />
        </ThreadRunBindings>
      )}
      {attachments === undefined ? null : (
        <div className="w-full min-w-0">
          <QuestionAttachments
            threadRunId={threadRunId}
            set={attachments}
            variant="preview"
          />
        </div>
      )}
    </div>
  );
}

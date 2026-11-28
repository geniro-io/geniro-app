import { MessageSquareText } from 'lucide-react';
import { Fragment, useMemo } from 'react';

import type { ProfileColor } from '../../shared/contracts';
import { questionAttachmentSetOf } from '../chats/question-attachments-payload';
import { QuestionContextMessages } from '../chats/question-context-messages';
import { ErrorText } from '../components/error-text';
import { Button } from '../components/ui/button';
import { PaletteDot } from '../components/ui/palette-dot';
import { Popover } from '../components/ui/popover';
import { type AnswerRequest, RequestCard } from './request-card';
import type { OpenRequest } from './use-open-requests';

export interface AnswerPopoverProps {
  /** The node's Answer button, which the popover hangs from. */
  anchor: HTMLElement;
  title: string;
  projectColor: ProfileColor | null;
  /** The cards the thread waits on the user for; the popover is drawn only while there is one. */
  requests: readonly OpenRequest[];
  error: string | null;
  onAnswer: AnswerRequest;
  /** Open the thread as its card on the canvas. */
  onShowThread: () => void;
  onClose: () => void;
}

/**
 * A graph node's waiting question or approval, answered where the user
 * pressed Answer: the thread's own card in a popover hung from the button,
 * answered the way the Needs you gallery answers it.
 */
export function AnswerPopover({
  anchor,
  title,
  projectColor,
  requests,
  error,
  onAnswer,
  onShowThread,
  onClose,
}: AnswerPopoverProps): React.JSX.Element | null {
  const triggerRef = useMemo(() => ({ current: anchor }), [anchor]);
  if (requests.length === 0) {
    return null;
  }
  return (
    <Popover
      open
      onClose={onClose}
      triggerRef={triggerRef}
      anchor="viewport"
      side="bottom"
      align="start"
      label={`Answer ${title}`}
      className="w-[400px] max-w-[calc(100vw-16px)]">
      <div data-slot="answer-popover" className="flex flex-col gap-2.5 p-3">
        <header className="flex min-w-0 items-center gap-2">
          {projectColor === null ? null : (
            <PaletteDot color={projectColor} size="md" />
          )}
          <span
            data-slot="answer-popover-title"
            title={title}
            className="min-w-0 flex-1 truncate text-sm font-semibold">
            {title}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-slot="answer-popover-show-chat"
            className="size-6 text-muted-foreground hover:text-foreground"
            aria-label={`Show the chat of ${title}`}
            title="Show chat"
            onClick={onShowThread}>
            <MessageSquareText aria-hidden="true" className="size-3.5" />
          </Button>
        </header>
        {error === null ? null : (
          <ErrorText className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs">
            {error}
          </ErrorText>
        )}
        {requests.map((request) => (
          <Fragment key={request.requestId}>
            <QuestionContextMessages
              threadRunId={request.runId}
              threadRequestId={request.requestId}
              attachments={
                questionAttachmentSetOf(request.item.payload) ?? undefined
              }
            />
            <RequestCard request={request} onAnswer={onAnswer} />
          </Fragment>
        ))}
      </div>
    </Popover>
  );
}

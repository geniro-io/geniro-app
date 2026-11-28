import { useContext } from 'react';

import { ApprovalCard } from '../chats/approval-card';
import { questionAttachmentSetOf } from '../chats/question-attachments-payload';
import { ThreadContextReaderContext } from '../chats/thread-question-context';
import { ThreadRunBindings } from '../chats/thread-run-bindings';
import { payloadString } from '../chats/transcript-payload';
import type { OpenRequest, OpenRequestsState } from './use-open-requests';

export type AnswerRequest = OpenRequestsState['answer'];

/**
 * One waiting card, the very one its thread pins above its composer, answered
 * the way the thread answers it, with a chip for each page the question
 * attached; its pictures and pages are read from the thread's run, as they are
 * in the thread.
 */
export function RequestCard({
  request,
  onAnswer,
}: {
  request: OpenRequest;
  onAnswer: AnswerRequest;
}): React.JSX.Element {
  const reader = useContext(ThreadContextReaderContext);
  const payload = request.item.payload as {
    input?: unknown;
    questions?: unknown;
    options?: unknown;
  } | null;
  const card = (
    <ApprovalCard
      toolName={payloadString(request.item.payload, 'toolName') ?? 'tool'}
      input={payload?.input ?? null}
      questions={payload?.questions}
      options={payload?.options}
      requestId={request.requestId}
      threadTitle={payloadString(request.item.payload, 'threadTitle')}
      threadText={payloadString(request.item.payload, 'threadText')}
      verdict={null}
      attached={questionAttachmentSetOf(request.item.payload) ?? undefined}
      runId={request.runId}
      onRespond={(allow, answer, images, optionId) =>
        onAnswer(request, allow, answer, images, optionId)
      }
    />
  );
  return reader === null ? (
    card
  ) : (
    <ThreadRunBindings reader={reader} threadRunId={request.runId}>
      {card}
    </ThreadRunBindings>
  );
}

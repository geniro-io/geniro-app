import { MessageCircleQuestion } from 'lucide-react';

import { Card } from '../components/ui/card';
import { THREAD_QUESTION_CARD } from './geniro-tool';
import { recordOf } from './tool-result-text';

/** A managed thread's open request, as the manager chat's relayed card carries it. */
export interface ThreadQuestionRelay {
  threadRunId: string;
  threadIsTeam: boolean;
  handle: string;
  threadTitle: string;
  toolName: string;
  input: unknown;
  questions?: unknown;
  options?: unknown;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The relayed request on a `thread_question` row's `input`, or null when its
 * thread, handle, title or tool is missing — the caller then draws the permission
 * body, which is still answerable.
 *
 * TWIN PARSER: `ThreadQuestionCardInput` in `apps/daemon/src/v1/agents/chat.types.ts`,
 * filled by `CommandCenterNotifyService`. A key renamed on either side must be
 * renamed on both.
 */
export function readThreadQuestionRelay(
  input: unknown,
): ThreadQuestionRelay | null {
  const record = recordOf(input);
  const threadRunId = readString(record?.threadRunId);
  const handle = readString(record?.handle);
  const threadTitle = readString(record?.threadTitle);
  const toolName = readString(record?.toolName);
  if (
    record === null ||
    threadRunId === null ||
    handle === null ||
    threadTitle === null ||
    toolName === null
  ) {
    return null;
  }
  return {
    threadRunId,
    threadIsTeam: record.threadIsTeam === true,
    handle,
    threadTitle,
    toolName,
    input: record.input,
    ...(record.questions === undefined ? {} : { questions: record.questions }),
    ...(record.options === undefined ? {} : { options: record.options }),
  };
}

/** The relayed request of an `approval_request` row, or null when the row is not a readable relay. */
export function threadQuestionRelayOfRow(
  payload: unknown,
): ThreadQuestionRelay | null {
  const record = recordOf(payload);
  return record?.toolName === THREAD_QUESTION_CARD
    ? readThreadQuestionRelay(record.input)
    : null;
}

/** What became of an answer pressed on the card, as its verdict row's `outcome` says. */
function deliveryNote(outcome: unknown): string | null {
  return outcome === 'not-delivered'
    ? 'Not delivered — the thread no longer waited on this.'
    : null;
}

/**
 * A managed thread's question or approval, drawn in the command center
 * manager's chat. `children` is the thread's own card; answering it answers
 * the thread. Closed with no answer, it says so in place of the card.
 */
export function ThreadQuestionCard({
  relay,
  verdict,
  outcome = null,
  expired = false,
  children,
}: {
  relay: ThreadQuestionRelay;
  /** null while pending; the user's answer once the verdict item arrived. */
  verdict: boolean | null;
  /** The verdict row's `outcome`: whether the answer reached the thread. */
  outcome?: unknown;
  /** Closed with no answer — answered in the thread, or its turn ended. */
  expired?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const closed = expired && verdict === null;
  const note = verdict === null ? null : deliveryNote(outcome);
  return (
    <Card
      data-slot="thread-question-card"
      className="flex min-w-0 flex-col gap-2.5 border-warning/40 p-3">
      <div className="flex min-w-0 items-center gap-2">
        <MessageCircleQuestion
          aria-hidden="true"
          className="size-4 shrink-0 text-warning"
        />
        <span className="min-w-0 flex-1 text-sm font-medium break-words">
          {relay.handle} · {relay.threadTitle}{' '}
          {verdict === null && !expired ? 'is waiting on you' : 'asked'}
        </span>
      </div>
      {closed ? (
        <p className="text-xs text-muted-foreground">
          No longer open — answered in the thread, or its turn ended.
        </p>
      ) : (
        children
      )}
      {note === null ? null : (
        <p className="text-xs text-destructive">{note}</p>
      )}
    </Card>
  );
}

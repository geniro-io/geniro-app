import {
  ChevronDown,
  MessageCircleQuestion,
  MessageSquare,
  X,
} from 'lucide-react';
import type React from 'react';
import { useContext } from 'react';

import {
  ArchiveThreadButton,
  useThreadArchive,
} from '../components/thread-archive';
import { ThreadActionButton } from '../components/thread-head';
import { cn } from '../components/ui/utils';
import type { FinishedThreadLine } from './hosted-thread';
import { ThreadDoneDismissalsContext } from './thread-done-context';
import { ThreadOpenContext } from './thread-title';
import { useThreadFlag } from './thread-ui-memory';

export const pinnedRequestsFoldedKey = (pinnedId: string): string =>
  `pinned-requests:folded:${pinnedId}`;

export function waitingOnYouLabel(questions: number, finished = 0): string {
  const parts = ['Waiting on you'];
  if (questions > 0) {
    parts.push(`${questions} ${questions === 1 ? 'question' : 'questions'}`);
  }
  if (finished > 0) {
    parts.push(`${finished} finished`);
  }
  return parts.join(' · ');
}

function FinishedLine({
  line,
}: {
  line: FinishedThreadLine;
}): React.JSX.Element {
  const open = useContext(ThreadOpenContext);
  const archive = useThreadArchive(line.runId);
  const dismissals = useContext(ThreadDoneDismissalsContext);
  return (
    <li
      data-slot="pinned-finished-line"
      data-run={line.runId}
      className="flex min-w-0 items-center gap-1.5 py-1 text-xs">
      <span
        title={line.title}
        className="min-w-0 flex-1 truncate font-medium text-foreground">
        {line.title}
      </span>
      <span className="shrink-0 text-muted-foreground">finished</span>
      {open === null ? null : (
        <ThreadActionButton
          slot="pinned-finished-open"
          label={`Open ${line.title}`}
          title="Open this thread's chat"
          icon={<MessageSquare aria-hidden="true" />}
          onClick={() => open(line.runId)}>
          Open chat
        </ThreadActionButton>
      )}
      {archive === null ? null : (
        <ArchiveThreadButton
          slot="pinned-finished-archive"
          title={line.title}
          onArchive={archive}
        />
      )}
      {dismissals === null ? null : (
        <ThreadActionButton
          slot="pinned-finished-dismiss"
          label={`Dismiss ${line.title}`}
          title="Remove this finished thread on every device; its next finish brings it back"
          icon={<X aria-hidden="true" />}
          onClick={() => dismissals.dismiss(line.runId, null)}>
          Dismiss
        </ThreadActionButton>
      )}
    </li>
  );
}

/**
 * Every open request lifted out of the transcript, above the composer: the
 * newest shown, the rest mounted and `hidden`, under one header row that folds
 * them all to a line — and, in the manager's chat, a line per finished thread
 * the user has not handled yet.
 *
 * Folding hides rather than unmounts, so a half-typed answer, its picks and its
 * staged attachments survive it, as they survive a newer question taking the pin.
 * The fold is remembered for the question that was pinned when it was pressed,
 * so a newer question always arrives unfolded instead of waiting behind a line.
 */
export function PinnedRequests<T extends { id: string }>({
  requests,
  pinnedId,
  renderCard,
  finished = [],
}: {
  requests: readonly T[];
  /** The request shown, or null while only finished threads wait. */
  pinnedId: string | null;
  renderCard: (request: T) => React.JSX.Element;
  finished?: readonly FinishedThreadLine[];
}): React.JSX.Element {
  const [folded, setFolded] = useThreadFlag(
    pinnedRequestsFoldedKey(pinnedId ?? 'finished'),
    false,
  );
  const action = folded
    ? pinnedId === null
      ? 'Show the finished threads'
      : 'Show the question'
    : 'Fold to one line';
  return (
    <div
      data-slot="pinned-request"
      // A role that can carry a name, so a screen-reader user typing into the
      // composer learns the turn has stopped on them. Not `aria-live`: the card
      // is full of controls, and announcing it on every keystroke is worse.
      role="region"
      aria-label={
        pinnedId === null
          ? 'Finished threads waiting on you'
          : 'Question waiting on your answer'
      }
      // Half of the chat column at most, so the conversation always keeps the
      // other half however short the column is.
      className="flex max-h-[50%] min-h-0 shrink flex-col border-t border-border bg-card/60">
      <button
        type="button"
        data-slot="pinned-request-toggle"
        aria-expanded={!folded}
        title={
          requests.length > 1
            ? `${action}. Answering this one opens the next.`
            : action
        }
        onClick={() => setFolded((value) => !value)}
        className="flex h-9 w-full shrink-0 items-center gap-1.5 px-4 text-left text-xs font-medium text-warning hover:bg-muted/50">
        <MessageCircleQuestion
          aria-hidden="true"
          className="size-3.5 shrink-0"
        />
        <span className="min-w-0 flex-1 truncate">
          {waitingOnYouLabel(requests.length, finished.length)}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            !folded && 'rotate-180',
          )}
        />
      </button>
      <div
        data-slot="pinned-request-cards"
        hidden={folded}
        className="min-h-0 overflow-y-auto px-4 pb-3">
        {requests.map((request) => (
          <div key={request.id} hidden={request.id !== pinnedId}>
            {renderCard(request)}
          </div>
        ))}
        {finished.length === 0 ? null : (
          <ul
            data-slot="pinned-finished"
            aria-label="Finished threads"
            className={cn(
              'm-0 flex list-none flex-col divide-y divide-border p-0',
              pinnedId !== null && 'mt-2 border-t border-border pt-1',
            )}>
            {finished.map((line) => (
              <FinishedLine key={line.runId} line={line} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

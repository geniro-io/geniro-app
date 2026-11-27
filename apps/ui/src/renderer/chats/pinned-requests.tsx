import { ChevronDown, MessageCircleQuestion } from 'lucide-react';
import type React from 'react';

import { cn } from '../components/ui/utils';
import { useThreadFlag } from './thread-ui-memory';

export const pinnedRequestsFoldedKey = (pinnedId: string): string =>
  `pinned-requests:folded:${pinnedId}`;

export function waitingOnYouLabel(count: number): string {
  return `Waiting on you · ${count} ${count === 1 ? 'question' : 'questions'}`;
}

/**
 * Every open request lifted out of the transcript, above the composer: the
 * newest shown, the rest mounted and `hidden`, under one header row that folds
 * them all to a line.
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
}: {
  requests: readonly T[];
  pinnedId: string;
  renderCard: (request: T) => React.JSX.Element;
}): React.JSX.Element {
  const [folded, setFolded] = useThreadFlag(
    pinnedRequestsFoldedKey(pinnedId),
    false,
  );
  const action = folded ? 'Show the question' : 'Fold to one line';
  return (
    <div
      data-slot="pinned-request"
      // A role that can carry a name, so a screen-reader user typing into the
      // composer learns the turn has stopped on them. Not `aria-live`: the card
      // is full of controls, and announcing it on every keystroke is worse.
      role="region"
      aria-label="Question waiting on your answer"
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
          {waitingOnYouLabel(requests.length)}
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
      </div>
    </div>
  );
}

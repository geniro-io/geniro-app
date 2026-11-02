import { Flag } from 'lucide-react';

import { OUTCOME_LABEL } from './goals-list';
import { MarkdownContent } from './markdown-content';
import { MessageBubble } from './message-bubble';
import type { ThreadOutcomePayload } from './thread-outcome-payload';

/**
 * How the thread ended, as an agent recorded it (`record_outcome`), drawn in its
 * flow. The newest such row is the thread's outcome; the agents panel names it.
 */
export function ThreadOutcomeRow({
  outcome,
  author,
}: {
  outcome: ThreadOutcomePayload;
  /** The recording agent's name, or null when the row is drawn under it already. */
  author: string | null;
}): React.JSX.Element {
  return (
    <MessageBubble variant="tool" className="text-foreground">
      <div
        data-slot="thread-outcome-row"
        className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Flag aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
          <span className="font-medium text-foreground">
            Outcome: {OUTCOME_LABEL[outcome.kind]}
          </span>
          {author === null ? null : <span>· {author}</span>}
        </span>
        <MarkdownContent content={outcome.summary} />
      </div>
    </MessageBubble>
  );
}

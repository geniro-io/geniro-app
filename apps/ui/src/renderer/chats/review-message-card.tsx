import { MessageSquareText } from 'lucide-react';
import { createContext, useContext } from 'react';

import { Button } from '../components/ui/button';
import { reviewLineLabel } from './review-comment-thread';
import type { ReviewPayloadView } from './review-payload';

/** Opens the review screen at one comment; null where no screen can open (a hosted view). */
export const OpenReviewCommentContext = createContext<
  ((number: number) => void) | null
>(null);

/** A sent review in the transcript: every comment it carried, each with a way back to its line. */
export function ReviewMessageCard({
  review,
}: {
  review: ReviewPayloadView;
}): React.JSX.Element {
  const open = useContext(OpenReviewCommentContext);
  const files = new Set(
    review.comments.map((comment) => `${comment.folder}\0${comment.path}`),
  ).size;
  const count = review.comments.length;
  return (
    <div data-slot="review-message-card" className="flex flex-col gap-2">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <MessageSquareText className="size-4 shrink-0" aria-hidden />
        {`Review · ${count} ${count === 1 ? 'comment' : 'comments'} in ${files} ${files === 1 ? 'file' : 'files'}`}
      </p>
      {review.note === null ? null : (
        <p className="text-sm whitespace-pre-wrap">{review.note}</p>
      )}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {review.comments.map((comment) => (
          <li
            key={comment.number}
            className="flex flex-col gap-1 rounded-md border border-border/60 bg-background/60 px-2.5 py-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 font-mono text-xs break-all text-muted-foreground">
                {`#${comment.number} · ${comment.path} · ${reviewLineLabel(comment.side, comment.startLine, comment.endLine)}`}
              </span>
              {open === null ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 px-2 text-xs"
                  onClick={() => open(comment.number)}>
                  Open in review
                </Button>
              )}
            </div>
            {comment.quote === '' ? null : (
              <pre className="overflow-x-auto rounded bg-muted/50 px-2 py-1 font-mono text-xs whitespace-pre text-muted-foreground">
                {comment.quote}
              </pre>
            )}
            <p className="text-sm whitespace-pre-wrap">{comment.body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

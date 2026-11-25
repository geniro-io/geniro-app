import { useState } from 'react';

import { ExpandableTextarea } from '../components/expandable-textarea';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';
import { markHiddenChars } from './hidden-char-marks';
import type { ReviewComment } from './use-review-comments';

export function reviewLineLabel(
  side: ReviewComment['side'],
  startLine: number | null,
  endLine: number | null,
): string {
  if (side === 'file' || startLine === null) {
    return 'Whole file';
  }
  const end = endLine ?? startLine;
  const lines =
    end === startLine ? `Line ${startLine}` : `Lines ${startLine}–${end}`;
  return side === 'old' ? `${lines} (removed)` : lines;
}

/** The code a comment quoted, wrapped to its container's width, hidden characters shown as marks. */
export function ReviewQuote({ quote }: { quote: string }): React.JSX.Element {
  return (
    <pre className="m-0 rounded-md bg-muted/50 px-2 py-1 font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">
      {markHiddenChars(quote)}
    </pre>
  );
}

/** The keys of a review text field: Cmd/Ctrl+Enter submits it, Esc closes it without closing the screen. */
export function reviewFieldKeys(
  onSubmit: () => void,
  onCancel: () => void,
): (event: React.KeyboardEvent) => void {
  return (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };
}

/** The field a comment is written in, in the diff under its lines: Cmd/Ctrl+Enter adds it, Esc closes it. */
export function ReviewCommentEditor({
  heading,
  initial = '',
  onSubmit,
  onCancel,
}: {
  heading: string;
  initial?: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}): React.JSX.Element {
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    const text = body.trim();
    if (text === '' || busy) {
      return;
    }
    setBusy(true);
    setFailed(null);
    try {
      await onSubmit(text);
      onCancel();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      data-slot="review-comment-editor"
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 font-sans"
      onKeyDown={reviewFieldKeys(() => void submit(), onCancel)}>
      <p className="text-xs text-muted-foreground">{heading}</p>
      <ExpandableTextarea
        ariaLabel="Review comment"
        title={heading}
        value={body}
        onChange={setBody}
        rows={3}
        autoFocus
        expandable={false}
        placeholder="Leave a comment for the agent"
      />
      {failed === null ? null : (
        <p className="text-xs text-destructive">{failed}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy || body.trim() === ''}
          onClick={() => void submit()}>
          Add to review
        </Button>
      </div>
    </div>
  );
}

const AGENT_BADGE: Record<NonNullable<ReviewComment['agentStatus']>, string> = {
  fixed: 'Agent: fixed',
  not_fixed: 'Agent: not fixed',
};

/** One comment beside its code: its state, the agent's answer and what the user can do next. */
export function ReviewCommentThread({
  comment,
  outdated,
  onEdit,
  onDelete,
  onStatus,
}: {
  comment: ReviewComment;
  outdated: boolean;
  onEdit: (body: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onStatus: (status: 'resolved' | 'sent') => Promise<void>;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  const resolved = comment.status === 'resolved';
  if (resolved && !unfolded) {
    return (
      <div
        data-slot="review-comment-thread"
        data-comment-number={comment.number}
        className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-1.5 font-sans text-xs text-muted-foreground">
        <span className="tabular-nums">#{comment.number}</span>
        <span>Resolved</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-6 px-2 text-xs"
          onClick={() => setUnfolded(true)}>
          Open
        </Button>
      </div>
    );
  }
  if (editing) {
    return (
      <ReviewCommentEditor
        heading={reviewLineLabel(
          comment.side,
          comment.startLine,
          comment.endLine,
        )}
        initial={comment.body}
        onSubmit={onEdit}
        onCancel={() => setEditing(false)}
      />
    );
  }
  const draft = comment.status === 'draft';
  return (
    <div
      data-slot="review-comment-thread"
      data-comment-number={comment.number}
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 font-sans text-sm',
        draft ? 'border-primary/40' : 'border-border',
      )}>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span className="tabular-nums text-foreground">#{comment.number}</span>
        <span>You</span>
        <Badge variant={draft ? 'default' : 'secondary'}>
          {draft ? 'Draft' : resolved ? 'Resolved' : 'Sent'}
        </Badge>
        {outdated ? <Badge variant="outline">Outdated</Badge> : null}
        {comment.agentStatus === null ? null : (
          <Badge
            variant="outline"
            className={cn(
              comment.agentStatus === 'fixed' ? 'text-success' : 'text-warning',
            )}>
            {AGENT_BADGE[comment.agentStatus]}
          </Badge>
        )}
        {outdated || comment.side === 'file' ? (
          <span>
            {reviewLineLabel(comment.side, comment.startLine, comment.endLine)}
          </span>
        ) : null}
      </div>
      {outdated && comment.quote !== '' ? (
        <ReviewQuote quote={comment.quote} />
      ) : null}
      <p className="break-words whitespace-pre-wrap text-foreground">
        {comment.body}
      </p>
      {comment.agentReply === null ? null : (
        <div className="min-w-0 rounded-md border-l-2 border-primary/50 bg-muted/40 px-2 py-1.5">
          <p className="text-xs font-medium text-muted-foreground">Agent</p>
          <p className="break-words whitespace-pre-wrap text-foreground">
            {comment.agentReply}
          </p>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-1">
        {draft ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setEditing(true)}>
            Edit
          </Button>
        ) : null}
        {comment.status === 'sent' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void onStatus('resolved')}>
            Resolve
          </Button>
        ) : null}
        {resolved ||
        (comment.status === 'sent' && comment.agentStatus !== null) ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title="Reopen it: the agent's answer stays, its mark goes"
            onClick={() => void onStatus('sent')}>
            Not fixed
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive"
          onClick={() => void onDelete()}>
          Delete
        </Button>
      </div>
    </div>
  );
}

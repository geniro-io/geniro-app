import { Clock, Pencil, SendHorizontal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '../components/ui/button';
import { Textarea } from '../components/ui/textarea';

/**
 * One message waiting to go out — text plus however many images rode with it.
 * Structural only: the wire shape of an image belongs to the caller.
 *
 * `id` is the caller's stable handle on the entry. Every control here reports
 * it back rather than a position, because the queue drains on its own: an index
 * captured when the row rendered can address a different message by the time
 * the user clicks it.
 */
export interface QueuedStripMessage {
  id: string;
  text: string;
  images: readonly unknown[];
}

/**
 * The queue strip above the composer: what the user has written that the agent
 * has NOT been given yet.
 *
 * **Why a queue at all, when claude can take a message mid-turn.** It can, and
 * the composer used to use that unconditionally — every follow-up went straight
 * into the running turn. That is the behaviour this replaced: a second thought
 * typed while the agent worked landed in its context at the next tool boundary,
 * so a message meant as "do this next" silently redirected the turn in flight,
 * and there was no moment at which the user could still change their mind. The
 * message is now HELD here and promoted to a real transcript bubble at the
 * moment it is POSTed — never earlier, and never on a guess about when the CLI
 * consumed it. (Prior art: Omnigent's `docs/QUEUE_STEER_DESIGN.md` rejects
 * consume-detection outright as unverifiable across harnesses.)
 *
 * Mid-turn delivery is therefore not gone, it is OPT-IN: that is `onSteer`.
 * Whether the run's CLI has any such channel is the daemon's answer
 * (`GET /v1/capabilities` → `followUps`), passed in as
 * `steerUnavailableReason` — never decided here by agent name. A CLI without
 * one gets the control inert carrying its own sentence, because a queued
 * message that cannot jump the turn is still going out and the user deserves
 * to know it is waiting rather than stuck.
 */
export function QueuedStrip({
  messages,
  steerUnavailableReason,
  steerStatus,
  onEdit,
  onRemove,
  onSteer,
}: {
  messages: readonly QueuedStripMessage[];
  /**
   * Why this run's CLI cannot be handed a message mid-turn, or null when it
   * can. Straight off the daemon's capability report.
   */
  steerUnavailableReason: string | null;
  /**
   * What became of the Send-now the user last pressed, or null when none is
   * outstanding. Both states exist because the press was otherwise SILENT: the
   * POST takes a moment (`sending`), and the daemon may refuse it outright
   * (`held`) — a refusal the caller deliberately does not raise as an error,
   * since the message stays queued and goes out when the turn ends. Without
   * this the control looked broken in both windows, which is exactly how it
   * was reported.
   */
  steerStatus: { id: string; state: 'sending' | 'held' } | null;
  /** Commit new text for the entry with this id. */
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  /** Send the entry with this id into the turn already running. */
  onSteer: (id: string) => void;
}): React.JSX.Element | null {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const steerBlocked = steerUnavailableReason !== null;

  useEffect(() => {
    if (editingId !== null) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingId]);

  // The queue drains on its own, so the row being edited can be sent out from
  // under the editor. Close when the entry itself leaves — keying on the id
  // rather than on `messages.length` means an unrelated row being removed no
  // longer throws away a draft the user is still typing.
  const editingGone =
    editingId !== null && !messages.some((message) => message.id === editingId);
  useEffect(() => {
    if (editingGone) {
      setEditingId(null);
    }
  }, [editingGone]);

  if (messages.length === 0) {
    return null;
  }

  const commit = (id: string): void => {
    const text = draft.trim();
    // An empty edit is a cancel, not a delete: removal is its own control, and
    // silently dropping the entry here would destroy an attachment that rode
    // with it. The original text stays.
    if (text.length > 0) {
      onEdit(id, text);
    }
    setEditingId(null);
  };

  return (
    // `role="group"` is what makes the label below stick: ARIA ignores an
    // accessible name on a generic element.
    <div
      role="group"
      aria-label="Queued messages"
      className="flex flex-col gap-1">
      {messages.map((message, index) => {
        const imageCount = message.images.length;
        const label =
          message.text ||
          (imageCount === 1 ? '1 image' : `${imageCount} images`);
        const position = index + 1;
        const steer = steerStatus?.id === message.id ? steerStatus.state : null;
        return (
          <div
            key={message.id}
            className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
            <Clock aria-hidden="true" className="size-3 shrink-0" />
            {editingId === message.id ? (
              // A Textarea, not an Input: this value is a composer prompt, and
              // `<input type=text>` applies HTML value sanitization, which
              // strips the newlines out of a multi-line one. Not
              // `ExpandableTextarea` either — its ⤢ opens a modal editor, which
              // fights this strip's own close-when-the-row-drains behaviour,
              // and it exposes no key/blur handling to commit through.
              <Textarea
                ref={inputRef}
                value={draft}
                rows={1}
                aria-label={`Edit queued message ${position}`}
                className="min-h-0 flex-1 resize-none px-1.5 py-0.5 text-xs"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  // One keystroke commits, so an Enter confirming an IME
                  // composition must not fire on a half-composed word.
                  if (event.nativeEvent.isComposing) {
                    return;
                  }
                  // Enter inserts a newline here — the whole point of the
                  // field — so committing moves to the modifier the composer
                  // itself uses.
                  if (
                    event.key === 'Enter' &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault();
                    commit(message.id);
                  } else if (event.key === 'Escape') {
                    // Unmounting a focused field fires no blur, so the
                    // abandoned draft cannot leak through the commit below.
                    setEditingId(null);
                  }
                }}
                onBlur={() => commit(message.id)}
              />
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate" title={message.text}>
                  {label}
                </span>
                {message.text && imageCount > 0 ? (
                  <span className="shrink-0">
                    {imageCount === 1 ? '+1 image' : `+${imageCount} images`}
                  </span>
                ) : null}
                {/* The outcome of a Send-now outranks the standing "sends
                    next": the user just acted on THIS row and is owed the
                    answer, where the position note is only ever ambient.
                    Only the HEAD goes out next — the old strip told every row
                    it was next, which on a three-deep queue was true of one. */}
                {steer !== null ? (
                  <span
                    className="shrink-0"
                    title={
                      steer === 'held'
                        ? 'The run would not take it mid-turn — it goes out when this turn ends'
                        : undefined
                    }>
                    {steer === 'sending' ? 'sending…' : 'still queued'}
                  </span>
                ) : index === 0 ? (
                  <span className="shrink-0">sends next</span>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-5 shrink-0"
                  aria-label={`Send queued message ${position} now`}
                  // `aria-disabled`, never `disabled`: the shared Button sets
                  // `disabled:pointer-events-none`, so a truly disabled control
                  // never fires the hover that would render `title` — the one
                  // place the daemon's reason is written. It would also drop
                  // out of the tab order, putting that sentence beyond a
                  // keyboard user entirely.
                  // Also inert while its own POST is in flight: the control
                  // stays hoverable (see above), and a second press would send
                  // the same message twice.
                  aria-disabled={steerBlocked || steer === 'sending'}
                  title={
                    steerUnavailableReason ??
                    'Send now — into the turn already running'
                  }
                  onClick={() => {
                    if (steerBlocked || steer === 'sending') {
                      return;
                    }
                    onSteer(message.id);
                  }}>
                  <SendHorizontal className="size-3 shrink-0" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-5 shrink-0"
                  aria-label={`Edit queued message ${position}`}
                  title="Edit before it goes out"
                  onClick={() => {
                    setDraft(message.text);
                    setEditingId(message.id);
                  }}>
                  <Pencil className="size-3 shrink-0" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-5 shrink-0"
                  aria-label={`Remove queued message ${position}`}
                  title="Remove from queue"
                  onClick={() => onRemove(message.id)}>
                  <X className="size-3 shrink-0" />
                </Button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

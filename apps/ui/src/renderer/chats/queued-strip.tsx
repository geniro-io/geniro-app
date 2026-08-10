import { Clock, Pencil, SendHorizontal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';

/**
 * One message waiting to go out — text plus however many images rode with it.
 * Structural only: the wire shape of an image belongs to the caller.
 */
export interface QueuedStripMessage {
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
 * one gets the control disabled carrying its own sentence, because a queued
 * message that cannot jump the turn is still going out and the user deserves
 * to know it is waiting rather than stuck.
 */
export function QueuedStrip({
  messages,
  steerUnavailableReason,
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
  /** Commit new text for the entry at `index`. */
  onEdit: (index: number, text: string) => void;
  onRemove: (index: number) => void;
  /** Send the entry at `index` into the turn already running. */
  onSteer: (index: number) => void;
}): React.JSX.Element | null {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingIndex !== null) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingIndex]);

  // The queue drains on its own, so the row being edited can be sent out from
  // under the editor. Closing on a length change keeps the draft from silently
  // re-targeting whatever entry inherited that index.
  useEffect(() => {
    setEditingIndex(null);
  }, [messages.length]);

  if (messages.length === 0) {
    return null;
  }

  const commit = (index: number): void => {
    const text = draft.trim();
    // An empty edit is a cancel, not a delete: removal is its own control, and
    // silently dropping the entry here would destroy an attachment that rode
    // with it. The original text stays.
    if (text.length > 0) {
      onEdit(index, text);
    }
    setEditingIndex(null);
  };

  return (
    <div className="flex flex-col gap-1" aria-label="Queued messages">
      {messages.map((message, index) => {
        const imageCount = message.images.length;
        const label =
          message.text ||
          (imageCount === 1 ? '1 image' : `${imageCount} images`);
        return (
          <div
            // Index keys are safe here: rows are addressed by index and
            // duplicate texts are legitimate queue entries.
            key={`${index}-${message.text}`}
            className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
            <Clock aria-hidden="true" className="size-3 shrink-0" />
            {editingIndex === index ? (
              <Input
                ref={inputRef}
                value={draft}
                aria-label={`Edit queued message ${index + 1}`}
                className="h-6 min-w-0 flex-1 px-1.5 py-0 text-xs"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  // One keystroke commits, so an Enter confirming an IME
                  // composition must not fire on a half-composed word.
                  if (event.nativeEvent.isComposing) {
                    return;
                  }
                  if (event.key === 'Enter') {
                    commit(index);
                  } else if (event.key === 'Escape') {
                    // Unmounting a focused field fires no blur, so the
                    // abandoned draft cannot leak through the commit below.
                    setEditingIndex(null);
                  }
                }}
                onBlur={() => commit(index)}
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
                {/* Only the HEAD goes out next. The old strip told every row it
                    was next, which on a three-deep queue was true of one. */}
                {index === 0 ? (
                  <span className="shrink-0">sends next</span>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-5 shrink-0"
                  aria-label={`Send queued message ${index + 1} now`}
                  disabled={steerUnavailableReason !== null}
                  title={
                    steerUnavailableReason ??
                    'Send now — into the turn already running'
                  }
                  onClick={() => onSteer(index)}>
                  <SendHorizontal className="size-3 shrink-0" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-5 shrink-0"
                  aria-label={`Edit queued message ${index + 1}`}
                  title="Edit before it goes out"
                  onClick={() => {
                    setDraft(message.text);
                    setEditingIndex(index);
                  }}>
                  <Pencil className="size-3 shrink-0" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-5 shrink-0"
                  aria-label={`Remove queued message ${index + 1}`}
                  title="Remove from queue"
                  onClick={() => onRemove(index)}>
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

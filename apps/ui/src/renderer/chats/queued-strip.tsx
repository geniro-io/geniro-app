import {
  ArrowUp,
  Clock,
  GripVertical,
  Pause,
  Pencil,
  Play,
  SendHorizontal,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '../components/ui/button';
import { Textarea } from '../components/ui/textarea';
import { cn } from '../components/ui/utils';

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
 *
 * **And the automatic half is itself opt-out** (`paused`): the queue can be
 * held, so that what leaves it is only ever a press. That is a different
 * question from `onSteer`'s — steering asks WHEN a message reaches the agent
 * relative to the turn in flight, pausing asks whether the queue advances at
 * all without being asked — which is why the two controls coexist rather than
 * one covering the other.
 */
export function QueuedStrip({
  messages,
  paused,
  turnInFlight,
  steerUnavailableReason,
  steerInterrupts = false,
  steerStatus,
  onEdit,
  onRemove,
  onReorder,
  onSteer,
  onTogglePause,
}: {
  messages: readonly QueuedStripMessage[];
  /**
   * The queue is HELD: nothing leaves it until the user releases a message.
   *
   * The default is off, and the strip says which mode it is in either way —
   * "waiting" and "held" look identical on a row, and the difference is the
   * whole question a reader has about a queue.
   */
  paused: boolean;
  /**
   * Whether a turn is running right now.
   *
   * Send-now means two different things across that line, which is why the
   * strip has to be told rather than inferring it from `steerUnavailableReason`
   * being set: with a turn in flight the message is handed to a CLI mid-turn,
   * which not every CLI has a channel for; with none, it simply starts the next
   * turn — something every CLI can do. Without this, a paused queue on an agent
   * that takes no mid-turn message had its release control permanently inert,
   * i.e. no way out of the pause at all.
   */
  turnInFlight: boolean;
  /**
   * Why this run's CLI cannot be handed a message mid-turn, or null when it
   * can. Straight off the daemon's capability report.
   */
  steerUnavailableReason: string | null;
  /**
   * Whether sending it now STOPS what the agent is currently doing — the
   * daemon's answer, per CLI.
   *
   * It changes only the sentence on the control, and that is the whole point:
   * on claude the message joins the running turn and nothing is lost, while
   * cursor's channel is a second prompt that cancels the first, so a press
   * there throws away the tool call in flight. Offering both under one label
   * would make the control lie to one of the two, and the moment to say which
   * is BEFORE the press — there is nothing to undo after it.
   */
  steerInterrupts?: boolean;
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
  /**
   * Move `id` to where `overId` currently sits.
   *
   * By ID on both sides, like every other control here and for the same
   * reason: the queue drains on its own, so an index captured when the row
   * rendered can address a different message by the time the pointer reaches
   * it. A no-op when either id has already gone out.
   */
  onReorder: (id: string, overId: string) => void;
  /** Hold the queue, or let it flow again. */
  onTogglePause: () => void;
}): React.JSX.Element | null {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // The daemon's reason is about the MID-TURN channel, so it can only block a
  // press that would use one. With no turn running, Send-now is an ordinary
  // turn start.
  const steerBlocked = turnInFlight && steerUnavailableReason !== null;

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

  // Both forms spelled out rather than derived with an `s`: this app has
  // shipped `2 categorys` to the screen once already.
  const waiting =
    messages.length === 1 ? '1 message' : `${messages.length} messages`;

  return (
    // `role="group"` is what makes the label below stick: ARIA ignores an
    // accessible name on a generic element.
    <div
      role="group"
      aria-label="Queued messages"
      className="flex flex-col gap-1">
      {/* ONE header line, and it exists for the pause — the rows already say
          what each of them is (`sends next`, `sending…`), so before there was
          a mode to be in, a heading over them would have been chrome counting
          the lines beneath it. What a row cannot say is why it is NOT moving,
          which is exactly the state the toggle creates: `held` and `waiting`
          are the same row. So the line states the mode in words, and carries
          the one control that acts on the queue as a whole.

          It carried a SECOND one for a release — a `Send next` button that
          released the head — and that was the same operation as the head row's
          own Send control, drawn a second way, six inches from it. Two
          affordances for one act is what the reuse rules exist to stop, and the
          duplicate is the one that had to go: an action belongs to the thing it
          acts on, and this line's subject is the queue's MODE. What replaced it
          is the head row's Send, promoted (below) — still one press. */}
      <div className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
        <Clock aria-hidden="true" className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {paused
            ? `Queue paused — ${waiting} held until you send them`
            : `${waiting} queued — the next goes out when this turn ends`}
        </span>
        {/* A toggle button rather than a Switch: a switch belongs to a settings
            row with a label beside it, and this states its own action in the
            word on it. `aria-pressed` is what makes it a toggle to a screen
            reader — the label names what pressing does, so the state would
            otherwise be unreadable. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={paused}
          className="h-6 shrink-0 gap-1 px-1.5 text-xs text-muted-foreground"
          title={
            paused
              ? 'Resume — the queue empties itself again as turns end'
              : 'Pause — nothing leaves the queue until you send it'
          }
          onClick={onTogglePause}>
          {paused ? (
            <Play aria-hidden="true" className="size-3 shrink-0" />
          ) : (
            <Pause aria-hidden="true" className="size-3 shrink-0" />
          )}
          {paused ? 'Resume' : 'Pause'}
        </Button>
      </div>
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
            // NAMED, because the strip is no longer only rows: `>  div` now
            // reaches the header too, and every index read off it would be one
            // out. The same reason the agents panel's card list carries a slot.
            data-slot="queued-message"
            // Dragged to reorder — REPORTED as "я хочу иметь возможность
            // drag-and-drop передвигать queue сообщений, чтобы контролировать,
            // какое сообщение следующим отправится первым". Same gesture as the
            // sidebar's groups, and deliberately the same shape: the list
            // rearranges under the pointer rather than jumping when the button
            // comes up.
            //
            // NOT while this row is being edited, for the reason `group-header`
            // records: a text field inside a draggable element cannot be
            // selected with the mouse, because the drag starts instead.
            draggable={editingId !== message.id}
            onDragStart={(event) => {
              // Firefox refuses to start a drag with no payload, and it is
              // never read back — the id is already in state below.
              event.dataTransfer.setData('text/plain', message.id);
              event.dataTransfer.effectAllowed = 'move';
              setDraggingId(message.id);
            }}
            onDragOver={(event) => {
              // A drag that did not start in this strip is not ours to accept:
              // the sidebar's chat rows are draggable too, and a chat dropped
              // on the queue would land nowhere.
              if (draggingId === null) {
                return;
              }
              // BEFORE the same-row check, and that ordering is the whole fix
              // for a REPORTED "wrong animation when i moving message in
              // message queue — it's like jumping back to its position before
              // moving". A drag whose LAST `dragover` was not prevented is an
              // unsuccessful drop, and the browser answers one by flying the
              // drag image back to where it was picked up. That is the jump.
              //
              // It fired on every reorder rather than occasionally, because
              // this list rearranges live UNDER the pointer: the carried row
              // follows the cursor, so the element the pointer is over when the
              // button comes up is almost always the dragged row itself — the
              // one case that used to return before reaching this line. The
              // move had already happened and the queue was right; only the
              // animation said otherwise, which is the worst kind of bug to
              // report, since nothing is actually broken to point at.
              //
              // The sidebar's sections have always prevented it unconditionally
              // and carry the same note. This is now the same rule in both
              // places: accept the drop everywhere the gesture can end, and
              // decide separately whether there is anything to MOVE.
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              // Passing over yourself is not a move, and reporting it would put
              // a `splice` in the caller's queue on every pointer twitch.
              if (draggingId === message.id) {
                return;
              }
              onReorder(draggingId, message.id);
            }}
            onDrop={(event) => event.preventDefault()}
            onDragEnd={() => setDraggingId(null)}
            className={cn(
              'rounded-md bg-muted/50 text-xs text-muted-foreground',
              // The row being carried, not the row it is over: the arrangement
              // under the cursor is already the answer, so the only thing left
              // to show is which one the pointer is holding.
              draggingId === message.id && 'opacity-40',
              // Two shapes, deliberately. A queued row is a one-line summary
              // and stays one; the EDITOR is a block, because what it holds is
              // a composer prompt — the same kind of text as the box below it,
              // and it was being asked for through a one-line slot barely
              // taller than its own border. That is the reported "some thin
              // line still left; it should be a proper text block".
              editingId === message.id
                ? 'flex flex-col gap-2 px-2 py-2'
                : 'flex items-center gap-1.5 px-2 py-1',
            )}>
            {editingId === message.id ? (
              // A Textarea, not an Input: this value is a composer prompt, and
              // `<input type=text>` applies HTML value sanitization, which
              // strips the newlines out of a multi-line one. Not
              // `ExpandableTextarea` either — its ⤢ opens a modal editor, which
              // fights this strip's own close-when-the-row-drains behaviour,
              // and it exposes no key handling to commit through.
              <>
                <span className="flex items-center gap-1.5">
                  <Clock aria-hidden="true" className="size-3 shrink-0" />
                  Editing message {position} — it goes out when this turn ends
                </span>
                <Textarea
                  ref={inputRef}
                  value={draft}
                  rows={3}
                  aria-label={`Edit queued message ${position}`}
                  // Sized like the composer it is a draft for, not like the row
                  // it replaced: real leading, real padding, three lines to
                  // start and a ceiling past which it scrolls rather than
                  // pushing the transcript off the screen. `resize-y` because
                  // the one thing a fixed block cannot know is how long THIS
                  // message is.
                  className="max-h-48 min-h-24 resize-y text-sm leading-relaxed"
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
                      setEditingId(null);
                    }
                  }}
                />
                {/* Committing on BLUR is gone with the one-line field, and the
                    two changes belong together: a block this size is something
                    a user clicks out of to read the transcript behind it, and
                    silently saving on the way out is only tolerable while the
                    edit is one line nobody can lose track of. With the buttons
                    visible, blur has to mean nothing at all — Cancel would
                    otherwise fire it and save the very draft it is discarding. */}
                <span className="flex items-center gap-1.5">
                  <span className="mr-auto">⌘↵ to save · Esc to cancel</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-muted-foreground"
                    onClick={() => setEditingId(null)}>
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7"
                    onClick={() => commit(message.id)}>
                    Save
                  </Button>
                </span>
              </>
            ) : (
              <>
                {/* The grip REPLACES the clock rather than joining it. The
                    clock said "this is waiting", which the strip's own heading,
                    the `sends next` note and the position all already say; what
                    nothing said was that the row can be picked up. One glyph
                    per row is the budget, and this is the one that adds
                    something.

                    A real button, not a decorative handle: dragging is the only
                    way to reorder otherwise, which puts the feature out of
                    reach of the keyboard entirely. `↑`/`↓` on it move the row,
                    which is the same operation the drag performs. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-5 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing"
                  aria-label={`Reorder queued message ${position}`}
                  title="Drag to reorder — or ↑ / ↓"
                  onKeyDown={(event) => {
                    const step =
                      event.key === 'ArrowUp'
                        ? -1
                        : event.key === 'ArrowDown'
                          ? 1
                          : 0;
                    if (step === 0) {
                      return;
                    }
                    const target = messages[index + step];
                    if (target === undefined) {
                      return;
                    }
                    // Or the composer's own scroll container moves instead of
                    // the row.
                    event.preventDefault();
                    onReorder(message.id, target.id);
                  }}>
                  <GripVertical className="size-3 shrink-0" />
                </Button>
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
                ) : index === 0 && !paused ? (
                  // `sends next` is a PROMISE, and a paused queue does not make
                  // it. Paused, this note is gone rather than reworded: the row
                  // carries a labelled Send instead, which says which row is
                  // next by being the one that offers the press — and a note
                  // beside a button that names the same fact is the queue strip
                  // saying it twice on one line.
                  <span className="shrink-0">sends next</span>
                ) : null}
                {/* The head of a PAUSED queue is where the mode's release
                    lives, so there it stops being one ghost glyph among three
                    and becomes the row's action: a round filled pill with the
                    ArrowUp the composer's own Send uses. Same button, same
                    handler, same refusal — only its weight changes, with what
                    the row is FOR.

                    Round and filled because that is this app's one language for
                    "this dispatches the message" (`Chats.tsx`'s Send), and a
                    release that looks like the Edit and Remove glyphs beside it
                    is a primary action drawn as a third icon. Every other row
                    keeps the glyph: those are out-of-order releases, which are
                    real but are not what the mode is about. */}
                <Button
                  type="button"
                  variant={paused && index === 0 ? 'default' : 'ghost'}
                  size={paused && index === 0 ? 'sm' : 'icon'}
                  className={cn(
                    'shrink-0',
                    // `h-5`, matching the glyph buttons it sits beside rather
                    // than the `sm` size's own 32px: a taller control sets the
                    // ROW's height, so the head stood 4px prouder than every
                    // row under it and the list read as ragged rather than as
                    // one row carrying an action.
                    paused && index === 0
                      ? 'h-5 gap-1 rounded-full px-2 text-xs'
                      : 'size-5',
                  )}
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
                    !turnInFlight
                      ? 'Send now — it starts the next turn'
                      : (steerUnavailableReason ??
                        (steerInterrupts
                          ? 'Send now — this stops what the agent is doing and answers this instead'
                          : 'Send now — into the turn already running'))
                  }
                  onClick={() => {
                    if (steerBlocked || steer === 'sending') {
                      return;
                    }
                    onSteer(message.id);
                  }}>
                  {paused && index === 0 ? (
                    <>
                      <ArrowUp aria-hidden="true" className="size-3 shrink-0" />
                      Send
                    </>
                  ) : (
                    <SendHorizontal className="size-3 shrink-0" />
                  )}
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

import { Plus, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { cn } from '../components/ui/utils';
import { TaskLabel } from './task-chip';
import { labelDotClass } from './task-labels';

/**
 * The daemon's own bounds (`TASK_LABEL_MAX` / `TASK_LABELS_MAX` in
 * `v1/tasks/tasks.types.ts`), restated here so the field cannot offer what the
 * route would refuse — a 21st label is a red banner, not a validation message.
 */
const LABEL_MAX = 40;
const LABELS_MAX = 20;

/**
 * How many of the board's existing labels are offered at once.
 *
 * A bound rather than a scroller: the row sits inside a property row that
 * already wraps, so an unbounded list would push the description off the panel
 * on a board with fifty labels. Typing narrows the set, which is the way past
 * the cap — and the count says how many are being withheld, so a label that is
 * there but not shown does not read as one that does not exist.
 */
const SUGGESTIONS_MAX = 8;

export function LabelEditor({
  labels,
  suggestions = [],
  onChange,
}: {
  labels: string[];
  /**
   * Every label already in use on this board, so a second card can be given one
   * by pressing it rather than by remembering how it was spelled.
   *
   * Free text is still the primary input — this is a shortcut onto the set that
   * exists, not a closed vocabulary, since the first card to carry a label has
   * to be able to invent it.
   */
  suggestions?: readonly string[];
  onChange: (next: string[]) => void;
}): React.JSX.Element {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  const add = (value: string): void => {
    // Silently ignoring a duplicate rather than refusing it: the label is
    // already on the task, so the user's intent is already satisfied and an
    // error would be about bookkeeping rather than about anything they wanted.
    if (value !== '' && !labels.includes(value)) {
      onChange([...labels, value]);
    }
  };

  const commit = (): void => {
    const value = draft.trim();
    setDraft('');
    setAdding(false);
    add(value);
  };

  const needle = draft.trim().toLowerCase();
  const offered = suggestions.filter(
    (label) =>
      !labels.includes(label) &&
      (needle === '' || label.toLowerCase().includes(needle)),
  );
  const shown = offered.slice(0, SUGGESTIONS_MAX);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {labels.map((label) => (
        // The SAME pill the card draws (`task-label.tsx`), plus the one thing
        // an editor adds. Two renderings of one label is how the panel came to
        // show a grey bordered chip for something the board showed as a
        // coloured dot.
        //
        // The `[&_button]` class is the escape hatch `global.css` documents:
        // it gives every bare button an explicit font-size, which outranks an
        // ancestor's, so the × would otherwise sit at base size inside a chip
        // sized for small text.
        <TaskLabel
          key={label}
          label={label}
          className="pr-0.5 [&_button]:text-[11px]">
          <button
            type="button"
            aria-label={`Remove label ${label}`}
            className="rounded-full p-0.5 opacity-70 hover:bg-accent hover:opacity-100"
            onClick={() => {
              onChange(labels.filter((row) => row !== label));
            }}>
            <X className="size-3" aria-hidden />
          </button>
        </TaskLabel>
      ))}

      {labels.length >= LABELS_MAX ? null : adding ? (
        <Input
          autoFocus
          value={draft}
          maxLength={LABEL_MAX}
          aria-label="New label"
          className="h-7 w-32 text-xs"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
            if (event.key === 'Escape') {
              // Escape ABANDONS rather than commits — the blur that follows
              // would otherwise add the very label the user just backed out of.
              setDraft('');
              setAdding(false);
            }
          }}
        />
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs text-muted-foreground"
          onClick={() => {
            setAdding(true);
          }}>
          <Plus className="size-3" aria-hidden />
          Label
        </Button>
      )}

      {/* The labels this board already uses, offered only while adding — a
          permanent row of them would be noise on every card, and the moment a
          user wants one is the moment they reached for `+ Label`.
          `w-full` puts them on their own line: the parent wraps, so without it
          they trail the input and the group reads as more of the card's own
          labels rather than as a set to choose from. */}
      {adding && shown.length > 0 ? (
        <div className="flex w-full flex-wrap items-center gap-1.5 pt-1">
          <span className="text-[10px] tracking-wide text-muted-foreground/70 uppercase">
            existing
          </span>
          {shown.map((label) => (
            <button
              key={label}
              type="button"
              aria-label={`Add label ${label}`}
              className="flex items-center gap-1.5 rounded-full border border-dashed border-border py-0.5 pr-2 pl-2 text-xs text-muted-foreground hover:border-solid hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              // The press must not blur the input first: `onBlur` commits and
              // closes the editor, which unmounts this button before its click
              // ever lands — so the chip would do nothing at all. Holding focus
              // also lets several be pressed in a row.
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                add(label);
                setDraft('');
              }}>
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  labelDotClass(label),
                )}
                aria-hidden
              />
              {label}
            </button>
          ))}
          {offered.length > shown.length ? (
            // Said out loud, so a label that exists but is not on screen does
            // not read as one that does not exist — typing narrows the set.
            <span className="text-xs text-muted-foreground">
              +{offered.length - shown.length} more — keep typing
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

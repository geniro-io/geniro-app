import { Plus, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { cn } from '../components/ui/utils';
import { labelDotClass } from './task-labels';

/**
 * The daemon's own bounds (`TASK_LABEL_MAX` / `TASK_LABELS_MAX` in
 * `v1/tasks/tasks.types.ts`), restated here so the field cannot offer what the
 * route would refuse — a 21st label is a red banner, not a validation message.
 */
const LABEL_MAX = 40;
const LABELS_MAX = 20;

export function LabelEditor({
  labels,
  onChange,
}: {
  labels: string[];
  onChange: (next: string[]) => void;
}): React.JSX.Element {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  const commit = (): void => {
    const value = draft.trim();
    setDraft('');
    setAdding(false);
    // Silently ignoring a duplicate rather than refusing it: the label is
    // already on the task, so the user's intent is already satisfied and an
    // error would be about bookkeeping rather than about anything they wanted.
    if (value !== '' && !labels.includes(value)) {
      onChange([...labels, value]);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {labels.map((label) => (
        <span
          key={label}
          //  is the documented escape hatch:
          // gives every bare button an explicit font-size that outranks an
          // ancestor's , so the × would otherwise render at base size.
          // The `[&_button]` half is the escape hatch `global.css` documents:
          // it gives every bare button an explicit font-size, which outranks
          // an ancestor's `text-xs`, so the remove control would otherwise sit
          // at base size inside a chip sized for small text.
          className="flex items-center gap-1.5 rounded-full border border-border py-0.5 pr-1 pl-2 text-xs [&_button]:text-xs">
          <span
            className={cn('size-2 shrink-0 rounded-full', labelDotClass(label))}
            aria-hidden
          />
          {label}
          <button
            type="button"
            aria-label={`Remove label ${label}`}
            className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => {
              onChange(labels.filter((row) => row !== label));
            }}>
            <X className="size-3" aria-hidden />
          </button>
        </span>
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
    </div>
  );
}

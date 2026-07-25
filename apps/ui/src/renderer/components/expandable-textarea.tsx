import { Maximize2 } from 'lucide-react';
import { useState } from 'react';

import { MarkdownEditorDialog } from './markdown-editor-dialog';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { cn } from './ui/utils';

/**
 * A `Textarea` with an expand affordance: the corner ⤢ opens the field in the
 * wide markdown editor popup (`MarkdownEditorDialog`), for text too long to
 * edit comfortably in a side panel. Mirrors the sibling Geniro web app's
 * textarea-with-expand widget, minus its RJSF plumbing — here the control
 * owns its own popup state, so it drops straight into a `Field` wherever a
 * plain `Textarea` would go.
 *
 * `onChange` receives the new text (not the event) because both editing
 * surfaces produce it: inline typing and a popup Save.
 */
export function ExpandableTextarea({
  id,
  value,
  onChange,
  title,
  rows = 5,
  placeholder,
  className,
}: {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  /** Names the field in the popup header, e.g. "Role / system prompt". */
  title: string;
  rows?: number;
  placeholder?: string;
  className?: string;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="relative">
      <Textarea
        id={id}
        value={value}
        rows={rows}
        placeholder={placeholder}
        // pr-9 keeps typed text from running under the expand button.
        className={cn('pr-9', className)}
        onChange={(event) => onChange(event.target.value)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Expand ${title}`}
        title="Open in editor"
        className="absolute top-1 right-1 size-7 text-muted-foreground [&_svg]:size-3.5"
        onClick={() => setExpanded(true)}>
        <Maximize2 />
      </Button>
      <MarkdownEditorDialog
        open={expanded}
        title={title}
        value={value}
        placeholder={placeholder}
        onCancel={() => setExpanded(false)}
        onSave={(next) => {
          onChange(next);
          setExpanded(false);
        }}
      />
    </div>
  );
}

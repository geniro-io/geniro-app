import { Maximize2 } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { MarkdownEditorDialog } from './markdown-editor-dialog';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { cn } from './ui/utils';

/**
 * When a computed `line-height` cannot be read as a number — jsdom answers
 * `''`, and a real browser can answer `normal` — the field falls back to this
 * multiple of its font size. It only ever decides how tall the BOUNDS are, so
 * a wrong guess costs a line either way and never the text itself.
 */
const FALLBACK_LINE_HEIGHT_RATIO = 1.5;

/**
 * A `Textarea` with an expand affordance: the corner ⤢ opens the field in the
 * wide markdown editor popup (`MarkdownEditorDialog`), for text too long to
 * edit comfortably in a side panel. Mirrors the sibling Geniro web app's
 * textarea-with-expand widget, minus its RJSF plumbing — here the control
 * owns its own popup state, so it drops straight into a `Field` wherever a
 * plain `Textarea` would go.
 *
 * **It GROWS with its text**, between {@link rows} and {@link maxRows}. It used
 * to be a fixed box, so a field's height said how much room the author of that
 * call site guessed it would need rather than how much the text actually takes
 * — REPORTED against the graph inspector's Description at `rows={3}`, whose
 * four-line value was cut mid-word with the rest reachable only by scrolling
 * inside a box three lines tall. Growing here rather than at each call site is
 * the point: `rows` is now the FLOOR (an empty field still looks like a field
 * rather than a one-line input) and the cap is what keeps a long prompt from
 * pushing every control below it off the panel. Past the cap the field scrolls,
 * exactly as it always did, and the ⤢ is still the way to see it all at once.
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
  maxRows = 10,
  placeholder,
  className,
}: {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  /** Names the field in the popup header, e.g. "Role / system prompt". */
  title: string;
  /** The FLOOR — how tall the field is with nothing in it. */
  rows?: number;
  /** The ceiling it grows to before it starts scrolling instead. */
  maxRows?: number;
  placeholder?: string;
  className?: string;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);

  const fit = useCallback((): void => {
    const el = fieldRef.current;
    if (el === null) {
      return;
    }
    const style = window.getComputedStyle(el);
    const fontSize = Number.parseFloat(style.fontSize);
    const parsedLine = Number.parseFloat(style.lineHeight);
    const lineHeight = Number.isFinite(parsedLine)
      ? parsedLine
      : (Number.isFinite(fontSize) ? fontSize : 16) *
        FALLBACK_LINE_HEIGHT_RATIO;
    const px = (raw: string): number => {
      const parsed = Number.parseFloat(raw);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    // `scrollHeight` covers content + padding but NOT the border, while the
    // height we set includes it — every box here is `border-box` under the
    // preflight. Adding it back is what keeps a field from being one border
    // short of its own text and scrolling by two pixels forever.
    const borders = px(style.borderTopWidth) + px(style.borderBottomWidth);
    const chrome = px(style.paddingTop) + px(style.paddingBottom) + borders;
    // Measured from a COLLAPSED box: `scrollHeight` never reports less than the
    // element's own height, so reading it without this makes the field a
    // one-way ratchet that can grow and never shrink again.
    el.style.height = 'auto';
    const wanted = el.scrollHeight + borders;
    const floor = rows * lineHeight + chrome;
    const ceiling = Math.max(maxRows, rows) * lineHeight + chrome;
    el.style.height = `${Math.min(Math.max(wanted, floor), ceiling)}px`;
  }, [maxRows, rows]);

  // LAYOUT effect, not a plain one: this runs on every keystroke, and measuring
  // after paint would show the reader one frame of the old height each time.
  useLayoutEffect(fit, [fit, value]);

  // The panel these fields live in is drag-resizable, and a narrower box wraps
  // the same text onto more lines — so width is a second input to the height
  // and nothing else would tell us it changed.
  useLayoutEffect(() => {
    const el = fieldRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);

  return (
    <div className="relative">
      <Textarea
        id={id}
        ref={fieldRef}
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

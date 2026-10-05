import { useEffect, useRef, useState } from 'react';

import { ErrorText } from './error-text';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { MdEditor } from './ui/md-editor';

/** Editor height inside the popup — roomy enough to hold a full role prompt. */
const EDITOR_HEIGHT = 520;

/**
 * The expanded editor popup for one long-text field — the desktop counterpart
 * of the sibling Geniro web app's `NodeExpandedTextareaModal`: a wide dialog
 * holding a live markdown editor, with Cancel / Save.
 *
 * Edits are STAGED: typing here changes nothing until Save, so Cancel (and
 * Escape, and the backdrop) genuinely abandons the edit. A reopened dialog
 * always starts from the caller's current value, never from a previous
 * visit's abandoned draft — the same contract as `WorkflowMetaDialog`.
 */
export function MarkdownEditorDialog({
  open,
  title,
  value,
  placeholder,
  maxLength,
  onSave,
  onCancel,
}: {
  open: boolean;
  /**
   * The longest text the field can store. The editor cannot cut a paste the
   * way a native `maxLength` does, so an over-long draft disables Save and
   * says by how much rather than being trimmed silently.
   */
  maxLength?: number;
  /** Names the field being edited, e.g. "Role / system prompt". */
  title: string;
  value: string;
  placeholder?: string;
  onSave: (next: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  const over =
    maxLength === undefined ? 0 : Math.max(0, draft.length - maxLength);

  // Seeded when the dialog OPENS, not whenever `value` moves: a field whose
  // value can change from elsewhere (a thread's notes, edited in another
  // window) would otherwise replace the text being edited here.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setDraft(value);
    }
    wasOpen.current = open;
  }, [open, value]);

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      className="max-w-[1100px]">
      <div className="flex flex-col gap-4">
        <MdEditor
          value={draft}
          onChange={setDraft}
          height={EDITOR_HEIGHT}
          placeholder={placeholder}
        />
        <div className="flex items-center justify-end gap-2">
          {over > 0 ? (
            <ErrorText className="mr-auto">
              {`${over.toLocaleString('en-US')} characters over the ${maxLength?.toLocaleString('en-US')} limit`}
            </ErrorText>
          ) : null}
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={over > 0}
            onClick={() => onSave(draft)}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

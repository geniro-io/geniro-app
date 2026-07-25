import { useEffect, useState } from 'react';

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
  onSave,
  onCancel,
}: {
  open: boolean;
  /** Names the field being edited, e.g. "Role / system prompt". */
  title: string;
  value: string;
  placeholder?: string;
  onSave: (next: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (open) {
      setDraft(value);
    }
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
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" onClick={() => onSave(draft)}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

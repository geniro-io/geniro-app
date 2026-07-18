import { useEffect, useState } from 'react';

import { ErrorText } from '../components/error-text';
import { Field } from '../components/field';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';

/**
 * Rename a run from the chat list — the same popup pattern as the workflow
 * meta dialog (the app's one way to edit a name; never an inline input).
 * Submit hands the trimmed title to the caller; Cancel changes nothing.
 */
export function RenameRunDialog({
  open,
  busy,
  error,
  initial,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error?: string | null;
  /** The run's current label, prefilled so a rename starts from it. */
  initial: string;
  onClose: () => void;
  onSubmit: (title: string) => void;
}): React.JSX.Element {
  const [title, setTitle] = useState('');

  // A reopened dialog starts from the run's current label — never from a
  // previous visit's abandoned draft.
  useEffect(() => {
    if (open) {
      setTitle(initial);
    }
  }, [open, initial]);

  const canSubmit = title.trim().length > 0 && !busy;

  return (
    <Dialog open={open} onClose={onClose} title="Rename chat">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) {
            return;
          }
          onSubmit(title.trim());
        }}>
        <Field label="Name" htmlFor="chat-rename-title">
          <Input
            id="chat-rename-title"
            value={title}
            placeholder="Review the auth module"
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        {error ? <ErrorText>{error}</ErrorText> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

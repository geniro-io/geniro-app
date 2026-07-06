import { useEffect, useState } from 'react';

import { ErrorText } from '../components/error-text';
import { Field } from '../components/field';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';

/**
 * The "New workflow" dialog: collect the workflow meta (name + optional
 * description) BEFORE anything exists. Create hands the meta to the caller —
 * which persists the workflow to the library and redirects into the builder —
 * while Cancel leaves the library untouched.
 */
export function CreateWorkflowDialog({
  open,
  busy,
  error,
  onClose,
  onCreate,
}: {
  open: boolean;
  busy: boolean;
  error?: string | null;
  onClose: () => void;
  onCreate: (meta: { name: string; description?: string }) => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  // A reopened dialog is a NEW workflow — never leak the previous draft.
  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
    }
  }, [open]);

  const canCreate = name.trim().length > 0 && !busy;

  return (
    <Dialog open={open} onClose={onClose} title="New workflow">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canCreate) {
            return;
          }
          const trimmedDescription = description.trim();
          onCreate({
            name: name.trim(),
            ...(trimmedDescription ? { description: trimmedDescription } : {}),
          });
        }}>
        <Field label="Name" htmlFor="workflow-name">
          <Input
            id="workflow-name"
            value={name}
            placeholder="Review team"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label="Description"
          htmlFor="workflow-description"
          hint="Optional — shown on the workflow's library card.">
          <Textarea
            id="workflow-description"
            value={description}
            rows={3}
            placeholder="What this agent team does…"
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        {error ? <ErrorText>{error}</ErrorText> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canCreate}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

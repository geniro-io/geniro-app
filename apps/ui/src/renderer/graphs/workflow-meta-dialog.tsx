import { useEffect, useState } from 'react';

import { ErrorText } from '../components/error-text';
import { Field } from '../components/field';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';

/**
 * The one workflow-meta form (name + optional description), shared by BOTH
 * meta flows so they stay identical: "New workflow" (empty form; Create
 * persists a fresh workflow) and the builder's "Change workflow" (form
 * prefilled from the open workflow; Save persists the new meta). Submit hands
 * the trimmed meta to the caller; Cancel changes nothing.
 */
export function WorkflowMetaDialog({
  open,
  busy,
  error,
  title,
  submitLabel,
  busyLabel,
  initial,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error?: string | null;
  title: string;
  submitLabel: string;
  busyLabel: string;
  /** Prefill for editing an existing workflow's meta; omit for a blank form. */
  initial?: { name: string; description?: string };
  onClose: () => void;
  onSubmit: (meta: { name: string; description?: string }) => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  // A reopened dialog starts from `initial` (or blank) — never from the
  // previous visit's abandoned draft.
  useEffect(() => {
    if (open) {
      setName(initial?.name ?? '');
      setDescription(initial?.description ?? '');
    }
    // `initial` is compared by its fields: a rename dialog reopened for the
    // same workflow must reset even when the caller rebuilt the object.
  }, [open, initial?.name, initial?.description]);

  const canSubmit = name.trim().length > 0 && !busy;

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) {
            return;
          }
          const trimmedDescription = description.trim();
          onSubmit({
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
          <Button type="submit" disabled={!canSubmit}>
            {busy ? busyLabel : submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

import { useEffect, useState } from 'react';

import { ErrorText } from '../components/error-text';
import { Field } from '../components/field';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import type { WorkflowMeta } from './graph-doc';

/**
 * The cap field's text as a value: undefined for empty (the machine ceiling),
 * null for anything that is not a whole number of one or more.
 */
function parseMaxActiveTurns(text: string): number | undefined | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/**
 * The one workflow-meta form (name, optional description, optional cap on
 * agent turns working at once), shared by BOTH meta flows so they stay
 * identical: "New workflow" (empty form; Create persists a fresh workflow) and
 * the builder's "Change workflow" (form prefilled from the open workflow; Save
 * persists the new meta). Submit hands the trimmed meta to the caller; Cancel
 * changes nothing.
 */
export function WorkflowMetaDialog({
  open,
  busy,
  error,
  title,
  submitLabel,
  busyLabel,
  initial,
  maxActiveTurnsCeiling,
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
  initial?: WorkflowMeta;
  /**
   * This Mac's ceiling on agent turns working at once in one run
   * (`GET /v1/capabilities`) — what an empty cap means. Null until it is read.
   */
  maxActiveTurnsCeiling: number | null;
  onClose: () => void;
  onSubmit: (meta: WorkflowMeta) => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [maxActiveTurns, setMaxActiveTurns] = useState('');

  // A reopened dialog starts from `initial` (or blank) — never from the
  // previous visit's abandoned draft.
  useEffect(() => {
    if (open) {
      setName(initial?.name ?? '');
      setDescription(initial?.description ?? '');
      setMaxActiveTurns(
        initial?.maxActiveTurns === undefined
          ? ''
          : String(initial.maxActiveTurns),
      );
    }
    // `initial` is compared by its fields: a rename dialog reopened for the
    // same workflow must reset even when the caller rebuilt the object.
  }, [open, initial?.name, initial?.description, initial?.maxActiveTurns]);

  const cap = parseMaxActiveTurns(maxActiveTurns);
  const canSubmit = name.trim().length > 0 && cap !== null && !busy;
  const ceiling =
    maxActiveTurnsCeiling === null
      ? 'this Mac’s ceiling'
      : maxActiveTurnsCeiling;

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
            ...(cap !== undefined ? { maxActiveTurns: cap } : {}),
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
        <Field
          label="Agents working at once"
          htmlFor="workflow-max-active-turns"
          hint={`Optional — how many agent calls of a run may work at the same time, at any depth; the rest wait their turn. Empty uses ${ceiling}, and a higher number runs at it.`}>
          {/* Text, not `type="number"`: a number input reports what it cannot
              parse as an empty string, which would save as "no cap". */}
          <Input
            id="workflow-max-active-turns"
            inputMode="numeric"
            value={maxActiveTurns}
            placeholder={
              maxActiveTurnsCeiling === null
                ? undefined
                : String(maxActiveTurnsCeiling)
            }
            aria-invalid={cap === null}
            onChange={(event) => setMaxActiveTurns(event.target.value)}
          />
        </Field>
        {cap === null ? (
          <ErrorText>
            Agents working at once must be a whole number of 1 or more, or
            empty.
          </ErrorText>
        ) : null}
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

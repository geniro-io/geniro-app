import { useId, useState } from 'react';

import { ErrorText } from '../components/error-text';
import { Field } from '../components/field';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { MdEditor } from '../components/ui/md-editor';
import { Select, type SelectGroup } from '../components/ui/select';
import {
  handleFromTitle,
  KNOWLEDGE_TITLE_MAX_CHARS,
  KNOWLEDGE_WHEN_MAX_CHARS,
  type KnowledgePlace,
} from './knowledge-text';

export interface KnowledgeFormValue {
  title: string;
  whenToRead: string;
  handle: string;
  body: string;
  place: string;
}

export interface KnowledgeFieldErrors {
  title?: string;
  whenToRead?: string;
  handle?: string;
  body?: string;
}

function refuseEmpty(value: KnowledgeFormValue): KnowledgeFieldErrors {
  return {
    ...(value.title.trim().length === 0
      ? { title: 'Give the document a title.' }
      : {}),
    ...(value.whenToRead.trim().length === 0
      ? { whenToRead: 'Say when to read it: agents choose by this line.' }
      : {}),
    ...(value.body.trim().length === 0
      ? { body: 'Write the text of the document.' }
      : {}),
  };
}

/** Pick the place of a new document; projects first, then teams, then Global. */
export function placeGroups(places: readonly KnowledgePlace[]): SelectGroup[] {
  const of = (kind: KnowledgePlace['kind']) =>
    places
      .filter((place) => place.kind === kind)
      .map((place) => ({
        value: place.key,
        label: place.label,
        hint: place.hint,
      }));
  return [
    { label: 'Projects', items: of('project') },
    { label: 'Teams', items: of('team') },
    { items: of('global') },
  ].filter((group) => group.items.length > 0);
}

/**
 * A document's fields. A new one's handle follows its title until the user
 * edits it, and it picks a place; an existing one says what a renamed handle
 * costs. The text opens without its preview pane: a live preview re-renders a
 * 256 KB document on every key.
 */
export function KnowledgeForm({
  value,
  places,
  isNew,
  busy,
  errors,
  submitLabel,
  onChange,
  onCancel,
  onSubmit,
}: {
  value: KnowledgeFormValue;
  places: readonly KnowledgePlace[];
  isNew: boolean;
  busy: boolean;
  /** What the daemon refused, on the field it belongs to. */
  errors: KnowledgeFieldErrors;
  submitLabel: string;
  onChange: (value: KnowledgeFormValue) => void;
  onCancel: () => void;
  onSubmit: () => void;
}): React.JSX.Element {
  const id = useId();
  const [local, setLocal] = useState<KnowledgeFieldErrors>({});
  const [handleEdited, setHandleEdited] = useState(!isNew);
  const shown = { ...errors, ...local };

  const set = (patch: Partial<KnowledgeFormValue>): void => {
    setLocal({});
    onChange({ ...value, ...patch });
  };

  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const empty = refuseEmpty(value);
        setLocal(empty);
        if (Object.keys(empty).length === 0) {
          onSubmit();
        }
      }}>
      <Field label="Title" htmlFor={`${id}-title`}>
        <Input
          id={`${id}-title`}
          value={value.title}
          maxLength={KNOWLEDGE_TITLE_MAX_CHARS}
          aria-invalid={shown.title !== undefined}
          onChange={(event) => {
            const title = event.target.value;
            set(
              handleEdited
                ? { title }
                : { title, handle: handleFromTitle(title) },
            );
          }}
        />
        {shown.title ? <ErrorText>{shown.title}</ErrorText> : null}
      </Field>
      <Field
        label="When to read"
        htmlFor={`${id}-when`}
        hint={
          shown.whenToRead
            ? undefined
            : 'Agents choose by this line. Say when the document helps, not what it holds.'
        }>
        <Input
          id={`${id}-when`}
          value={value.whenToRead}
          maxLength={KNOWLEDGE_WHEN_MAX_CHARS}
          aria-invalid={shown.whenToRead !== undefined}
          onChange={(event) => set({ whenToRead: event.target.value })}
        />
        {shown.whenToRead ? <ErrorText>{shown.whenToRead}</ErrorText> : null}
      </Field>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Field
          label="Handle"
          htmlFor={`${id}-handle`}
          hint={
            shown.handle
              ? undefined
              : isNew
                ? 'How instructions name this document. Follows the title until you edit it.'
                : 'Instructions that name the old handle stop finding this document.'
          }>
          <Input
            id={`${id}-handle`}
            value={value.handle}
            aria-invalid={shown.handle !== undefined}
            onChange={(event) => {
              setHandleEdited(true);
              set({ handle: event.target.value });
            }}
          />
          {shown.handle ? <ErrorText>{shown.handle}</ErrorText> : null}
        </Field>
        {isNew ? (
          <Field label="Place">
            <Select
              aria-label="Place"
              groups={placeGroups(places)}
              value={value.place}
              onValueChange={(place) => set({ place })}
            />
          </Field>
        ) : null}
      </div>
      <Field label="Text">
        <MdEditor
          value={value.body}
          preview="edit"
          highlight={false}
          height={420}
          onChange={(body) => set({ body })}
        />
        {shown.body ? <ErrorText>{shown.body}</ErrorText> : null}
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

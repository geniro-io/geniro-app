import { useState } from 'react';

import { Textarea } from '../components/ui/textarea';

/**
 * TWIN LIMIT: `MAX_ANSWER_LENGTH` in `apps/daemon/src/v1/agents/chat.types.ts`
 * — the cap on every `answer` a verdict carries: a question card's answer, and
 * a proposal card's note, which rides the same field. Enforced here rather than
 * only counted: the send would be refused at the daemon edge, and a card that
 * let the user type past it would lose their words to a failure they were given
 * no warning about.
 */
export const MAX_ANSWER_LENGTH = 32_768;

/**
 * The optional note a proposal card sends beside its verdict, on either
 * button — the plan card's and the workflow card's one contract.
 */
export function useVerdictNote(
  respond: (allow: boolean, answer?: string) => void,
): {
  draft: string;
  setDraft: (value: string) => void;
  tooLong: boolean;
  send: (allow: boolean) => void;
} {
  const [draft, setDraft] = useState('');
  const trimmed = draft.trim();
  const tooLong = trimmed.length > MAX_ANSWER_LENGTH;
  const send = (allow: boolean): void => {
    if (tooLong) {
      return;
    }
    // Arity preserved: a verdict sent with nothing typed is the same
    // one-argument verdict every other permission card sends, so the daemon's
    // note branch is never entered with an empty string.
    if (trimmed.length === 0) {
      respond(allow);
    } else {
      respond(allow, trimmed);
    }
  };
  return { draft, setDraft, tooLong, send };
}

/** The note box, and the line saying a note is too long to send. */
export function VerdictNoteField({
  draft,
  onChange,
  tooLong,
  placeholder,
}: {
  draft: string;
  onChange: (value: string) => void;
  tooLong: boolean;
  placeholder: string;
}): React.JSX.Element {
  return (
    <>
      <Textarea
        value={draft}
        onChange={(event) => onChange(event.target.value)}
        rows={2}
        className="min-h-0 text-sm"
        aria-label="Note to the agent"
        placeholder={placeholder}
      />
      {tooLong ? (
        <p className="m-0 text-xs text-destructive">
          That note is too long to send.
        </p>
      ) : null}
    </>
  );
}

/**
 * A settled card's note, shown back: it went to the agent, so what the agent
 * is working from has to be readable in the transcript rather than only in the
 * box it was typed into.
 */
export function VerdictNoteEcho({
  note,
}: {
  note: string | null;
}): React.JSX.Element | null {
  return note !== null && note.trim() !== '' ? (
    <p className="m-0 max-h-40 overflow-auto rounded-md border border-primary/20 bg-primary/10 px-2.5 py-1.5 text-sm break-words whitespace-pre-wrap">
      {note}
    </p>
  ) : null;
}

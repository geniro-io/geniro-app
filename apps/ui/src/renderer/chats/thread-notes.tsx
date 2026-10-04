import { useEffect, useRef, useState } from 'react';

import { ErrorText } from '../components/error-text';
import { Textarea } from '../components/ui/textarea';
import { useDebouncedPersist } from '../components/use-debounced-persist';

/**
 * Longest a thread's notes may be — the daemon's `MAX_RUN_NOTES_LENGTH`
 * (`apps/daemon/src/v1/agents/chat.types.ts`). Twinned here as the field's
 * `maxLength` so a paste past it is cut on screen rather than refused by the
 * daemon after the user has looked away.
 */
export const MAX_THREAD_NOTES_LENGTH = 10_000;

/** The run row's notes as the field shows them: absent is an empty field. */
const asText = (notes: string | null | undefined): string => notes ?? '';

/**
 * The user's own notes on one thread — a plain field, saved a moment after
 * they stop typing and again on the way out. Never sent to the agent.
 *
 * The field keeps its OWN draft rather than rendering the run row: every save
 * is echoed back on `runs_changed`, and binding the field to that echo would
 * put an older save over text still being typed. A change arriving from
 * elsewhere (another window) is adopted only while the field is neither
 * focused nor waiting on a write of its own.
 */
export function ThreadNotes({
  notes,
  onSave,
  autoFocus = false,
}: {
  notes: string | null | undefined;
  /** Writes the whole text; rejects when it could not be stored. */
  onSave: (text: string) => Promise<void>;
  autoFocus?: boolean;
}): React.JSX.Element {
  const [draft, setDraft] = useState(() => asText(notes));
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  // The newest text handed to the debounce and not yet confirmed stored.
  const unsaved = useRef<string | null>(null);
  // Replies can land out of order; only the newest write's outcome may set or
  // clear the error.
  const writes = useRef(0);
  const persist = useDebouncedPersist(async (text: string) => {
    const seq = ++writes.current;
    try {
      await onSave(text);
    } catch (err) {
      if (seq === writes.current) {
        setError('These notes could not be saved — your text is kept here.');
      }
      // Rethrown so the hook keeps the text owed and retries it on the way out.
      throw err;
    }
    if (unsaved.current === text) {
      unsaved.current = null;
    }
    if (seq === writes.current) {
      setError(null);
    }
  });

  useEffect(() => {
    if (focused.current || unsaved.current !== null) {
      return;
    }
    setDraft(asText(notes));
  }, [notes]);

  return (
    <div className="flex flex-col gap-1">
      <Textarea
        aria-label="Thread notes"
        placeholder="Notes for yourself — the agent never sees them"
        value={draft}
        maxLength={MAX_THREAD_NOTES_LENGTH}
        autoFocus={autoFocus}
        className="max-h-80 min-h-20 resize-y text-sm"
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
        }}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          unsaved.current = text;
          persist.schedule(text);
        }}
      />
      {error === null ? null : (
        <ErrorText className="text-xs">{error}</ErrorText>
      )}
    </div>
  );
}

/** Whether a thread's notes hold anything worth a marker. */
export function hasThreadNotes(notes: string | null | undefined): boolean {
  return notesPreview(notes) !== null;
}

/**
 * What a hover shows for a thread's notes — the text trimmed and cut at `limit`
 * characters, its line breaks kept. Null when the notes hold nothing worth
 * showing, which is also when no marker is drawn.
 */
export function notesPreview(
  notes: string | null | undefined,
  limit = 400,
): string | null {
  const text = (notes ?? '').trim();
  if (text === '') {
    return null;
  }
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

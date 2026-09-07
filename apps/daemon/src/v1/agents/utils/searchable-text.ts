/**
 * Flattens one transcript item's payload into the short string `Item.searchText`
 * holds, so a search can match a conversation the client never loaded.
 *
 * The client holds at most `HISTORY_PAGE` items, so filtering there misses
 * silently — search has to be a daemon query, and a daemon query needs one
 * column to look in. Every kind carries a different payload shape, so this is
 * the one place that knows how to read text out of all of them.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/tool-render.ts` reads the same
 * `file_path`/`filePath`/`path`/`notebook_path` and `command`/`cmd`/`script`
 * spellings out of the same tool payloads, for the transcript's own rendering.
 * An item payload is `z.unknown()` on the wire BY DESIGN — every kind carries a
 * different shape — so no generated type spans the two sides, and that module
 * cannot be imported here in any case: it pulls in `refractor` through
 * `components/ui/code-language`, and the daemon imports nothing from the
 * renderer. Add a spelling there and it belongs here too, or the transcript will
 * highlight a path that search cannot find.
 */

/**
 * Payload keys whose string values are worth matching on.
 *
 * An allowlist rather than a walk over every string in the payload: ids, enum
 * tags and model names are strings too, and sweeping them in makes a search for
 * `error` match every row carrying a status of that name. Keys are read from
 * whichever kinds carry them — `text` from a message, `message` from a system
 * or error row, `prompt` from a delegate launch — so a kind this table does not
 * name still contributes whatever of these it happens to hold.
 */
const TEXT_KEYS = [
  'text',
  'message',
  'prompt',
  'result',
  'name',
  'toolName',
  'label',
  'title',
  'caption',
  'description',
  'activity',
  'content',
] as const;

/** The file a tool is acting on, under any of the spellings in use. */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path'] as const;

/** The shell command a tool is running, under any of the spellings in use. */
const COMMAND_KEYS = ['command', 'cmd', 'script'] as const;

/**
 * The ceiling on one row's searchable text.
 *
 * A tool result can be a whole file. Storing it verbatim would put the
 * transcript's bulk in a second column and roughly double the database for a
 * feature that only needs to find the row — the snippet the user reads is cut
 * from the payload at query time, not from here.
 */
const MAX_SEARCH_TEXT_CHARS = 2000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function collect(
  record: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  const found: string[] = [];
  for (const key of keys) {
    const text = asText(record[key]);
    if (text !== null) {
      found.push(text);
    }
  }
  return found;
}

/**
 * A task list's own titles, which are the only text on that row.
 *
 * The list is a fold of every announcement from the first, so the row a user
 * remembers by a task's wording is this one and nothing else in the transcript
 * repeats it.
 */
function taskTitles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const titles: string[] = [];
  for (const entry of value) {
    const task = asRecord(entry);
    if (task === null) {
      continue;
    }
    const title =
      asText(task.title) ?? asText(task.content) ?? asText(task.text);
    if (title !== null) {
      titles.push(title);
    }
  }
  return titles;
}

/**
 * The searchable text for one persisted item, or null when it carries none.
 *
 * Null rather than an empty string, so `searchText IS NULL` stays the honest
 * predicate for "this row has not been through the flattener" — which is what
 * the backfill sweeps on. A row with genuinely nothing to match gets an empty
 * string instead of null for that same reason.
 */
export function searchableText(payload: unknown): string | null {
  const record = asRecord(payload);
  if (record === null) {
    return null;
  }

  const parts = [...collect(record, TEXT_KEYS), ...taskTitles(record.tasks)];

  // A tool call's own target: the path it edits and the command it runs live
  // one level down, under `input`, and they are the two things a user searches
  // a transcript for by name.
  const input = asRecord(record.input);
  if (input !== null) {
    parts.push(...collect(input, PATH_KEYS), ...collect(input, COMMAND_KEYS));
  }
  // A result row reports the same two at the top level rather than under
  // `input`, so both levels are read rather than assuming the call's shape.
  parts.push(...collect(record, PATH_KEYS), ...collect(record, COMMAND_KEYS));

  const flattened = parts.join(' ').replace(/\s+/g, ' ').trim();
  return flattened.slice(0, MAX_SEARCH_TEXT_CHARS);
}

/**
 * The form stored in `Item.searchText` — the same text, LOWERCASED.
 *
 * SQLite's `LIKE` folds case for ASCII and for ASCII only, so a lowercased
 * query term matches `Bash` and does NOT match `Проверка`. Transcripts here are
 * routinely not in English, so matching one script and silently missing another
 * is the defect this exists to prevent — and the alternative, `lower()` around
 * the column in every query, makes the predicate un-indexable and has to be
 * remembered at each call site.
 *
 * The column is therefore an INDEX value and never a display one: a hit's
 * quoted snippet is cut from the payload's own text at query time, so the user
 * reads the sentence as it was written.
 */
export function searchIndexText(payload: unknown): string | null {
  return searchableText(payload)?.toLowerCase() ?? null;
}

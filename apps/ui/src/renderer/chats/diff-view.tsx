import { isProposedChange, SAVE_PROJECT_INSTRUCTIONS } from './geniro-tool';

/**
 * geniro's OWN patch-proposal tool.
 *
 * TWIN: `HOST_PATCH_TOOL` in `apps/daemon/src/v1/agents/chat.types.ts`. A bare
 * literal because nothing generated spans this seam — the name reaches the
 * renderer inside an `approval_request` payload, which is `z.unknown()` on the
 * wire by design. `transcript-groups.ts` keeps the same literal for the same
 * reason; renaming the tool means renaming it in all three.
 */
export const PROPOSE_PATCH = 'propose_patch';

/**
 * The project card's changed lines as unified-diff hunks and the `P-` ids it
 * carries out, or null for another tool or a card with no hunks.
 *
 * TWIN PARSER: `projectInstructionsCardInput` in the daemon's
 * `agents/utils/host-project-instructions.ts` writes the input this file
 * reads — `diff` and `ids` here, the whole `old_string` / `new_string` in
 * `editDiffOf`.
 */
export function projectInstructionsCardOf(
  toolName: string,
  input: unknown,
): { diff: string; ids: string[] } | null {
  if (toolName !== SAVE_PROJECT_INSTRUCTIONS || !input) {
    return null;
  }
  const { diff, ids } = input as { diff?: unknown; ids?: unknown };
  if (typeof diff !== 'string' || diff === '') {
    return null;
  }
  return {
    diff,
    ids: Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

/**
 * Extract the old/new texts of a file-editing tool input, when this tool IS
 * one: an Edit carries `old_string`→`new_string`, a Write (file creation)
 * carries only `content`. Null for every other tool/shape — callers fall
 * back to their raw-JSON body. Shared by the tool-group rows and the
 * approval card, so both surfaces render the same diff for the same call.
 *
 * geniro's `propose_patch` rides the Edit arm rather than growing a renderer of
 * its own, and that is why the tool advertises `Edit`'s field names: a proposal
 * and an edit are the same diff, differing only in who writes the file and
 * when. Its `old_string` is optional, so it falls through to the Write shape —
 * additions only — when the patch creates or rewrites a whole file.
 */
export function editDiffOf(
  toolName: string,
  input: unknown,
): { oldText: string | null; newText: string } | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const record = input as Record<string, unknown>;
  if (toolName === 'Edit' || isProposedChange(toolName)) {
    const oldText = record.old_string;
    const newText = record.new_string;
    if (typeof newText === 'string') {
      // An absent `old_string` is only legal for a proposal, where it means a
      // whole-file write or a project with no instructions yet; an Edit
      // missing one is a malformed call and falls through to the raw-JSON
      // body, as it always has.
      if (typeof oldText === 'string') {
        return { oldText, newText };
      }
      if (isProposedChange(toolName)) {
        return { oldText: null, newText };
      }
    }
  }
  if (toolName === 'Write' && typeof record.content === 'string') {
    return { oldText: null, newText: record.content };
  }
  return null;
}

/**
 * GitHub-style line diff for file-editing tool calls: the removed text as
 * red `-` lines, the added text as green `+` lines. Purely presentational —
 * an Edit shows old→new, a Write (file creation) shows only added lines.
 * Colours come from the destructive/success tokens.
 */
export function DiffView({
  oldText,
  newText,
}: {
  oldText?: string | null;
  newText: string;
}): React.JSX.Element {
  const lines = (text: string): string[] => text.split('\n');
  return (
    <div
      data-slot="diff"
      className="overflow-x-auto rounded-md border border-border font-mono text-xs">
      {oldText
        ? lines(oldText).map((line, index) => (
            <div
              key={`old-${index}`}
              className="flex bg-destructive/10 text-destructive">
              <span
                aria-hidden="true"
                className="w-5 shrink-0 select-none pl-1.5">
                -
              </span>
              <span className="whitespace-pre-wrap break-all pr-2">{line}</span>
            </div>
          ))
        : null}
      {lines(newText).map((line, index) => (
        <div key={`new-${index}`} className="flex bg-success/10 text-success">
          <span aria-hidden="true" className="w-5 shrink-0 select-none pl-1.5">
            +
          </span>
          <span className="whitespace-pre-wrap break-all pr-2">{line}</span>
        </div>
      ))}
    </div>
  );
}

const REMOVED_CLASS = 'bg-destructive/10 text-destructive';
const ADDED_CLASS = 'bg-success/10 text-success';

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * How each line of a unified diff is drawn. Inside a hunk a line is what its
 * first character says, counted down against the header's line counts — so
 * added text that begins `++` or removed text that begins `--` (a Markdown
 * rule, a CLI flag) is never mistaken for a file header.
 */
function unifiedLineClasses(lines: readonly string[]): string[] {
  let oldLeft = 0;
  let newLeft = 0;
  return lines.map((line) => {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('\\')) {
        return 'text-muted-foreground';
      }
      if (line.startsWith('+')) {
        newLeft -= 1;
        return ADDED_CLASS;
      }
      if (line.startsWith('-')) {
        oldLeft -= 1;
        return REMOVED_CLASS;
      }
      oldLeft -= 1;
      newLeft -= 1;
      return 'text-foreground';
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null) {
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
      return 'text-muted-foreground';
    }
    return unifiedLineClass(line);
  });
}

/** How a line outside any hunk is drawn — decided by its first character. */
function unifiedLineClass(line: string): string {
  // Order matters: `+++` and `---` are FILE HEADERS and start with the same
  // characters as an added and a removed line. Read as content they would paint
  // every file's header as a change, which on a one-line change is most of what
  // the reader sees.
  if (line.startsWith('+++') || line.startsWith('---')) {
    return 'text-muted-foreground';
  }
  if (line.startsWith('@@')) {
    return 'text-muted-foreground';
  }
  if (line.startsWith('+')) {
    return 'bg-success/10 text-success';
  }
  if (line.startsWith('-')) {
    return 'bg-destructive/10 text-destructive';
  }
  if (line.startsWith('diff --git') || line.startsWith('index ')) {
    return 'text-muted-foreground';
  }
  return 'text-foreground';
}

/**
 * A UNIFIED diff, as git prints one — the other shape a diff reaches this app in.
 *
 * Beside {@link DiffView} rather than in a file of its own, because the two are
 * one subject seen from two directions: that one is handed the before and after
 * of a tool call and computes nothing, this one is handed git's own rendering
 * and only colours it. Split apart they would sooner or later stop looking alike,
 * on a screen where a reader meets both.
 *
 * It COLOURS and never re-derives: the hunk arithmetic is git's, and a second
 * implementation of it here would be a chance to disagree with the tool that
 * produced the text. `wordLevel` only marks, inside lines the hunks already
 * pair, the words that differ.
 */
export function UnifiedDiff({
  diff,
  wordLevel = false,
}: {
  diff: string;
  /** Mark the words that changed inside each removed/added line pair. */
  wordLevel?: boolean;
}): React.JSX.Element {
  const lines = diff.split('\n');
  const classes = unifiedLineClasses(lines);
  const changed = wordLevel
    ? changedSpans(lines, classes)
    : new Map<number, { start: number; end: number }>();
  return (
    <div
      data-slot="unified-diff"
      className="overflow-x-auto rounded-md border border-border font-mono text-xs">
      {lines.map((line, index) => {
        const span = changed.get(index);
        return (
          <div
            key={index}
            className={`whitespace-pre-wrap break-all px-2 ${classes[index]}`}>
            {/* A non-breaking space so an empty context line still occupies one
                row — without it a blank line in the source collapses and the
                diff reads as having fewer lines than it has. */}
            {line === '' ? (
              ' '
            ) : span === undefined ? (
              line
            ) : (
              <>
                {line.slice(0, span.start)}
                <span
                  data-changed
                  className={
                    line.startsWith('-')
                      ? 'rounded-sm bg-destructive/25'
                      : 'rounded-sm bg-success/25'
                  }>
                  {line.slice(span.start, span.end)}
                </span>
                {line.slice(span.end)}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * For each removed line paired with the added line in the same place of the
 * run after it, the part of both that differs, widened to whole words.
 */
function changedSpans(
  lines: readonly string[],
  classes: readonly string[],
): Map<number, { start: number; end: number }> {
  const spans = new Map<number, { start: number; end: number }>();
  let index = 0;
  while (index < lines.length) {
    if (classes[index] !== REMOVED_CLASS) {
      index += 1;
      continue;
    }
    const removed: number[] = [];
    while (classes[index] === REMOVED_CLASS) {
      removed.push(index);
      index += 1;
    }
    const added: number[] = [];
    while (classes[index] === ADDED_CLASS) {
      added.push(index);
      index += 1;
    }
    for (
      let pair = 0;
      pair < Math.min(removed.length, added.length);
      pair += 1
    ) {
      const [oldSpan, newSpan] = differingSpans(
        lines[removed[pair]!]!,
        lines[added[pair]!]!,
      );
      spans.set(removed[pair]!, oldSpan);
      spans.set(added[pair]!, newSpan);
    }
  }
  return spans;
}

/** Where two diff lines (sign included) differ, widened to word boundaries. */
function differingSpans(
  before: string,
  after: string,
): [{ start: number; end: number }, { start: number; end: number }] {
  let start = 1;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  ) {
    start += 1;
  }
  while (start > 1 && !/\s/.test(before[start - 1]!)) {
    start -= 1;
  }
  let shared = 0;
  while (
    shared < before.length - start &&
    shared < after.length - start &&
    before[before.length - 1 - shared] === after[after.length - 1 - shared]
  ) {
    shared += 1;
  }
  while (shared > 0 && !/\s/.test(before[before.length - shared]!)) {
    shared -= 1;
  }
  return [
    { start, end: before.length - shared },
    { start, end: after.length - shared },
  ];
}

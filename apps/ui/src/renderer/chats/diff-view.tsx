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
  if (toolName === 'Edit' || toolName === PROPOSE_PATCH) {
    const oldText = record.old_string;
    const newText = record.new_string;
    if (typeof newText === 'string') {
      // An absent `old_string` is only legal for the proposal, where it means a
      // whole-file write; an Edit missing one is a malformed call and falls
      // through to the raw-JSON body, as it always has.
      if (typeof oldText === 'string') {
        return { oldText, newText };
      }
      if (toolName === PROPOSE_PATCH) {
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

/** How one line of a unified diff is drawn — decided by its first character. */
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
 * produced the text.
 */
export function UnifiedDiff({ diff }: { diff: string }): React.JSX.Element {
  return (
    <div
      data-slot="unified-diff"
      className="overflow-x-auto rounded-md border border-border font-mono text-xs">
      {diff.split('\n').map((line, index) => (
        <div
          key={index}
          className={`whitespace-pre-wrap break-all px-2 ${unifiedLineClass(line)}`}>
          {/* A non-breaking space so an empty context line still occupies one
              row — without it a blank line in the source collapses and the diff
              reads as having fewer lines than it has. */}
          {line === '' ? ' ' : line}
        </div>
      ))}
    </div>
  );
}

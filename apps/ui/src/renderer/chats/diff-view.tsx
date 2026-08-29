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

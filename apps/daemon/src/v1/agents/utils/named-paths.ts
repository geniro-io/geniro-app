/**
 * What may follow a folder's path where a tool call names that folder itself
 * (or a file under it), in the payload's stored JSON text: a separator, a
 * quote or escape, shell punctuation. Requiring one is what keeps `/x/a` from
 * matching inside `/x/ab`.
 */
const PATH_ENDS = new Set([
  '/',
  '"',
  '\\',
  "'",
  ' ',
  ';',
  ')',
  '&',
  '|',
  ',',
  ':',
  '`',
  '>',
  '<',
  '}',
  ']',
]);

/**
 * The texts that name `path` in a payload persisted with `JSON.stringify` —
 * the path itself, and its form relative to the run's folder.
 *
 * An agent that created the folder from inside the run's own folder may name
 * it relatively (`.claude/worktrees/x`), so the relative form counts too — but
 * only with two segments or more: a lone `wt` would turn up in any command.
 */
export function namedPathForms(
  path: string,
  runFolders: readonly string[],
): string[] {
  const forms = new Set([path]);
  for (const folder of runFolders) {
    if (path.startsWith(`${folder}/`)) {
      const relative = path.slice(folder.length + 1);
      if (relative.includes('/')) {
        forms.add(relative);
      }
    }
  }
  return [...forms].map((form) => JSON.stringify(form).slice(1, -1));
}

/**
 * What may come right before a RELATIVE form for it to begin a path — a shell
 * word boundary or a quote — so `.claude/worktrees/x` is not found inside
 * another repository's `/elsewhere/.claude/worktrees/x`.
 */
const PATH_STARTS = new Set([
  ' ',
  '"',
  "'",
  '=',
  '(',
  '`',
  ';',
  '&',
  '|',
  ',',
  ':',
  '>',
  '<',
]);

/**
 * Whether `text` carries `form` as a path: followed by a path boundary, and —
 * for a relative form — beginning one (or after `./`). An absolute form begins
 * with `/`, which is its own left edge.
 */
export function namesForm(text: string, form: string): boolean {
  let at = text.indexOf(form);
  while (at !== -1) {
    const next = text[at + form.length];
    if (
      next !== undefined &&
      PATH_ENDS.has(next) &&
      (form.startsWith('/') || beginsPath(text, at))
    ) {
      return true;
    }
    at = text.indexOf(form, at + 1);
  }
  return false;
}

/** Line breaks and tabs, as the stored JSON text spells them. */
const ESCAPED_WHITESPACE = ['\\n', '\\t', '\\r'];

function beginsPath(text: string, at: number): boolean {
  const start = text.startsWith('./', at - 2) ? at - 2 : at;
  return (
    start === 0 ||
    PATH_STARTS.has(text[start - 1] ?? '') ||
    ESCAPED_WHITESPACE.some((escape) => text.startsWith(escape, start - 2))
  );
}

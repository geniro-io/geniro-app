/**
 * The BASE of the file name to suggest for a chat export, built from the
 * thread's own label — no extension.
 *
 * The extension is MAIN's (`save-chat-export.ts`), because main is what orders
 * the save panel's filters and therefore what knows which format is the default
 * one. Deciding it here as well would be two answers to one question, and the
 * one that lost would show the user a name whose extension the panel then
 * silently changed.
 *
 * A thread's name is whatever the user typed or the agent generated, so it
 * routinely holds the characters a file name cannot: a `/` (which macOS shows
 * as a `:` and which would make the dialog open somewhere else entirely), a
 * NUL, a leading dot that hides the file in Finder. Main REFUSES a name with a
 * separator in it rather than sanitizing one — see `chatExportSaveSchema` — so
 * the shaping has to happen here, where the label is, and the refusal stays a
 * bug-catcher rather than something the happy path relies on.
 *
 * The name is a SUGGESTION: the user renames it in the dialog if they like.
 * That is why an unusable label falls back to a fixed word instead of failing —
 * a thread called `///` is still worth exporting.
 */
export function chatExportBaseName(label: string): string {
  return exportBaseName(label, { fallback: 'chat', suffix: '-export' });
}

/**
 * The same shaping for any saved file named after something the user or an
 * agent wrote — a thread's title, an artifact's.
 *
 * Extracted when the artifact export became the second caller, rather than
 * copied: every rule below is about what a FILE NAME may carry, which does not
 * change with what is being saved. What the callers differ on is only the word
 * to fall back to and whether the name carries a suffix.
 */
export function exportBaseName(
  label: string,
  options: { fallback: string; suffix?: string },
): string {
  const slug = label
    .normalize('NFC')
    // Anything a path separator, a shell or a file manager would act on, plus
    // whitespace runs — one class, because the answer for all of them is the
    // same and two passes is how they come to disagree.
    // eslint-disable-next-line no-control-regex -- control characters are precisely what a file name may not carry
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    // A LEADING dot hides the file on macOS and Linux, and `.`/`..` name a
    // directory rather than a file. Stripping them is what makes the fallback
    // below reachable for a label made entirely of dots.
    .replace(/^\.+/, '')
    // Bounded well inside the 255-byte limit main enforces, leaving room for
    // the suffix below — a generated title can be a whole opening line.
    .slice(0, 80)
    .replace(/-+$/, '');
  // The fallback stands in for the SLUG and is then suffixed like any other,
  // so a thread called `///` still exports as `chat-export` rather than as a
  // bare `chat` — the suffix says what the file IS, and that is as true of the
  // fallback as of a real title.
  return `${slug === '' ? options.fallback : slug}${options.suffix ?? ''}`;
}

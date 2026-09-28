/**
 * A markdown image whose PATH contains a space, made parseable.
 *
 * CommonMark allows no space in a bare link destination, so
 * `![shot](/Users/me/Library/Application Support/x.png)` is not an image at
 * all — the parser leaves the whole reference as literal text. Every task
 * worktree and every task attachment lives under `~/Library/Application
 * Support/`, so for a screenshot an agent points at this is the ORDINARY case:
 * REPORTED as "i should be able to see images, but i dont see" against a task
 * description, and again when an agent's before/after screenshots reached the
 * chat as raw text. The spec's own escape is the angle-bracket form,
 * `![shot](</path with spaces.png>)`, so a spaced destination is rewritten
 * into it before the parser sees it.
 *
 * Code is left alone: a fence or an inline span SHOWING such markdown is the
 * one place where the literal text is what the writer meant.
 */
export function wrapSpacedImagePaths(markdown: string): string {
  if (!markdown.includes('](')) {
    return markdown;
  }
  return markdown
    .split(CODE)
    .map((part, index) =>
      // `split` with ONE capturing group puts the code it matched at the odd
      // indices, so those pass through untouched.
      index % 2 === 1 ? part : part.replace(IMAGE, wrapDestination),
    )
    .join('');
}

/**
 * The file-system spelling of the path a markdown image names.
 *
 * The markdown pipeline percent-encodes a destination on its way to `src`
 * (`mdast-util-to-hast` runs it through `normalizeUri`), so the space in
 * `…/Application Support/…` arrives as `%20` — and the daemon, asked for that
 * literal path, finds no file. Decoded once; text that is not valid
 * percent-encoding is handed back as it came.
 */
export function localPathOf(reference: string): string {
  if (reference.startsWith('data:') || !reference.includes('%')) {
    return reference;
  }
  try {
    return decodeURI(reference);
  } catch {
    return reference;
  }
}

/** Fenced blocks and inline code spans — ONE capturing group, see above. */
const CODE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/;

/** `![alt](destination)` whose destination is not already in `<…>`. */
const IMAGE = /!\[([^\]\n]*)\]\(([^)<\n][^)\n]*)\)/g;

/**
 * A trimmed destination split into its PATH and its optional quoted title —
 * the title keeping the whitespace that separated it, so it can be written back
 * exactly as it came.
 *
 * A SCAN from the end rather than the pattern it replaces,
 * `/^(.*?)(\s+(?:"[^"\n]*"|'[^'\n]*'))$/`, which is QUADRATIC in a run of
 * whitespace with no title at its end: the lazy prefix retries the whitespace
 * run from every position. It ran on every image destination in every rendered
 * message, on text an agent wrote — measured at 0.5s for 32,000 spaces and 8s
 * for 128,000, with the renderer frozen throughout.
 *
 * The same answer as that pattern for every input: a title is the LAST quoted
 * segment (it cannot contain its own quote, so its opening quote is the
 * previous one of the same kind), and it counts only when whitespace stands
 * directly before it — all of that whitespace belonging to the title, which is
 * what the pattern's lazy prefix left it.
 */
function splitTitle(trimmed: string): { path: string; title: string } {
  const untitled = { path: trimmed, title: '' };
  const quote = trimmed.at(-1);
  if (trimmed.length < 2 || (quote !== '"' && quote !== "'")) {
    return untitled;
  }
  const open = trimmed.lastIndexOf(quote, trimmed.length - 2);
  if (open <= 0 || !/\s/.test(trimmed[open - 1]!)) {
    return untitled;
  }
  let start = open - 1;
  while (start > 0 && /\s/.test(trimmed[start - 1]!)) {
    start -= 1;
  }
  const path = trimmed.slice(0, start);
  // The pattern's `.` could not cross a line terminator, so a path holding one
  // had no title at all — kept, so every input answers exactly as it did.
  if (LINE_TERMINATORS.some((terminator) => path.includes(terminator))) {
    return untitled;
  }
  return { path, title: trimmed.slice(start) };
}

/**
 * What a regex `.` does not match — `\n` never reaches here (see IMAGE).
 * Spelled by code point: the build writes U+2028 out literally, and inside a
 * regex literal that is a line break the parser refuses.
 */
const LINE_TERMINATORS = [
  '\r',
  String.fromCharCode(0x2028),
  String.fromCharCode(0x2029),
];

function wrapDestination(
  whole: string,
  alt: string,
  destination: string,
): string {
  const { path: raw, title } = splitTitle(destination.trim());
  const path = raw.trim();
  if (!/\s/.test(path)) {
    return whole;
  }
  return `![${alt}](<${path}>${title})`;
}

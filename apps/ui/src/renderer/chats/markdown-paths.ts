/**
 * A markdown image, or a link to a local absolute path, whose PATH contains a
 * space, made parseable.
 *
 * CommonMark allows no space in a bare link destination, so
 * `![shot](/Users/me/Library/Application Support/x.png)` is not an image at
 * all — the parser leaves the whole reference as literal text, and
 * `[notes](/Users/me/Library/Application Support/notes.md)` is no link to
 * click. Every task worktree and every task attachment lives under
 * `~/Library/Application Support/`, so this is the ORDINARY case for a file an
 * agent points at. The spec's own escape is the angle-bracket form,
 * `![shot](</path with spaces.png>)`, so a spaced destination is rewritten
 * into it before the parser sees it. A link is rewritten only when it names a
 * local absolute path: a web address with a space is broken either way.
 *
 * Code is left alone: a fence or an inline span SHOWING such markdown is the
 * one place where the literal text is what the writer meant.
 */
export function wrapSpacedPaths(markdown: string): string {
  if (!markdown.includes('](')) {
    return markdown;
  }
  return markdown
    .split(CODE)
    .map((part, index) =>
      // `split` with ONE capturing group puts the code it matched at the odd
      // indices, so those pass through untouched.
      index % 2 === 1 ? part : part.replace(IMAGE_OR_LINK, wrapDestination),
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

/**
 * The extensions the daemon's image route serves, lower case.
 *
 * TWIN PARSER: `IMAGE_EXTENSIONS` in
 * `apps/daemon/src/v1/agents/services/local-image.service.ts`, which refuses
 * any other extension before opening the file.
 */
export const PICTURE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

/** Whether a local path names a file the daemon's image route would serve. */
export function namesPicture(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && PICTURE_EXTENSIONS.includes(name.slice(dot).toLowerCase());
}

/** Fenced blocks and inline code spans — ONE capturing group, see above. */
const CODE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/;

/**
 * `![alt](destination)` or `[text](destination)` whose destination is not
 * already in `<…>`, with one level of balanced parentheses in it (`Foo (1)`).
 * Neither the text nor the destination may hold a square bracket: each attempt
 * then ends at the next `[`, which keeps a line of thousands of them linear.
 */
const IMAGE_OR_LINK =
  /(!?)\[([^[\]\n]*)\]\((?!<)((?:[^()[\]\n]|\([^()[\]\n]*\))+)\)/g;

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
 * What a regex `.` does not match — `\n` never reaches here (see IMAGE_OR_LINK).
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
  bang: string,
  label: string,
  destination: string,
  offset: number,
  text: string,
): string {
  const { path: raw, title } = splitTitle(destination.trim());
  const path = raw.trim();
  if (!/\s/.test(path)) {
    return whole;
  }
  if (bang === '' && (!isLocalPath(path) || isEscaped(text, offset))) {
    return whole;
  }
  return `${bang}[${label}](<${path}>${title})`;
}

function isLocalPath(path: string): boolean {
  return /^\/[^/\s]/.test(path);
}

function isEscaped(text: string, offset: number): boolean {
  let backslashes = 0;
  while (text[offset - 1 - backslashes] === '\\') {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

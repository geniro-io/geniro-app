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

/** A destination followed by its optional quoted title. */
const TITLED = /^(.*?)(\s+(?:"[^"\n]*"|'[^'\n]*'))$/;

function wrapDestination(
  whole: string,
  alt: string,
  destination: string,
): string {
  const trimmed = destination.trim();
  const titled = TITLED.exec(trimmed);
  const path = (titled?.[1] ?? trimmed).trim();
  if (!/\s/.test(path)) {
    return whole;
  }
  return `![${alt}](<${path}>${titled?.[2] ?? ''})`;
}

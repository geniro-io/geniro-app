import { extname, isAbsolute } from 'node:path';

/** How many images one card's report may bring onto it. */
export const MAX_REPORT_IMAGES = 10;

/** The image kinds a report may attach — the same four the chat store takes. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/**
 * A markdown image: `![alt](path)`, `![alt](<path with spaces>)`, optionally
 * with a `"title"` after the path.
 */
const MARKDOWN_IMAGE =
  /!\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\s*\)/g;

/** How deep the walk descends — a report payload is two or three levels. */
const MAX_DEPTH = 6;

/**
 * The screenshots a task's report asks to have kept: every markdown image with
 * an ABSOLUTE path to an image file, anywhere in the given payloads, in the
 * order written, each once, at most {@link MAX_REPORT_IMAGES}.
 *
 * The one shape the report instructions ask for (`task-prompt.ts`'s
 * `REPORT_SCREENSHOTS`), and deliberately nothing looser: a bare path in prose
 * cannot be told from a sentence that merely MENTIONS a file, and attaching
 * every image a transcript names would file the fixtures an agent read as
 * though they were pictures of its work.
 *
 * It walks every STRING in a payload rather than reading one named field,
 * because the report arrives in two shapes — a `report_findings` payload with
 * text in each finding, and a message's `text` — and a key renamed on either
 * would otherwise silently stop the attach.
 */
export function reportImagePaths(payloads: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (found.length >= MAX_REPORT_IMAGES || depth > MAX_DEPTH) {
      return;
    }
    if (typeof value === 'string') {
      for (const match of value.matchAll(MARKDOWN_IMAGE)) {
        const path = (match[1] ?? match[2] ?? '').trim();
        if (
          path === '' ||
          !isAbsolute(path) ||
          !IMAGE_EXTENSIONS.has(extname(path).slice(1).toLowerCase()) ||
          seen.has(path)
        ) {
          continue;
        }
        seen.add(path);
        found.push(path);
        if (found.length >= MAX_REPORT_IMAGES) {
          return;
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry, depth + 1);
      }
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const entry of Object.values(value)) {
        visit(entry, depth + 1);
      }
    }
  };
  visit(payloads, 0);
  return found;
}

import { isAbsolute, normalize, sep } from 'node:path';

/** Characters of the body read with the title for a stated limit. */
export const STATES_RULE_BODY_CHARS = 200;

/** Paths kept per entry; a longer list adds nothing to the reference check. */
export const REFERENCED_PATHS_MAX = 20;

const LIMIT_WORDS =
  /(?<![\p{L}\p{N}])(never|must not|forbidden)(?![\p{L}\p{N}])/iu;
const LIMIT_STEMS = /(?<![\p{L}\p{N}])(нельзя|никогда|запрещ)/iu;

const PATH_TOKEN =
  /(?<![\w./~@:-])([\w@.][\w.@-]*(?:\/[\w.@-]+)+(?::\d+(?:[-:]\d+)*)?)(?=$|[\s`'")\]},;!?]|[.:](?:\s|$))/gu;

/**
 * Whether the title or the opening of the body states a limit — the lexical
 * sign that an entry is a rule, read in English and Russian.
 */
export function statesRule(title: string, body: string): boolean {
  const text = `${title}\n${body.slice(0, STATES_RULE_BODY_CHARS)}`;
  return LIMIT_WORDS.test(text) || LIMIT_STEMS.test(text);
}

/**
 * The repo-relative file paths an entry names: a token with at least one
 * slash whose last part has an extension, never a URL, an absolute path, a
 * home path or one that climbs out with `..`.
 */
export function referencedPathsOf(title: string, body: string): string[] {
  const found = new Set<string>();
  for (const match of `${title}\n${body}`.matchAll(PATH_TOKEN)) {
    const path = cleanPath(match[1] ?? '');
    if (path !== null) {
      found.add(path);
    }
    if (found.size >= REFERENCED_PATHS_MAX) {
      break;
    }
  }
  return [...found];
}

/** The path as a project-relative one inside the folder, or null when it escapes. */
export function confinedPath(path: string): string | null {
  if (path.length === 0 || isAbsolute(path)) {
    return null;
  }
  const normalized = normalize(path);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    return null;
  }
  return normalized;
}

/** A stored JSON list of paths, or an empty list when it holds none. */
export function pathsOf(stored: string | null): string[] {
  if (stored === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

/** A list of paths as stored: null when empty. */
export function storedPaths(paths: readonly string[]): string | null {
  return paths.length === 0 ? null : JSON.stringify(paths);
}

function cleanPath(raw: string): string | null {
  const path = raw.replace(/\.+$/u, '').replace(/:\d+(?:[-:]\d+)*$/u, '');
  const parts = path.split('/');
  const first = parts[0] ?? '';
  const last = parts.at(-1) ?? '';
  if (
    !/[^.]\.[\w-]+$/u.test(last) ||
    /^[\w-]+(?:\.[\w-]+)+$/u.test(first) ||
    parts.some((part) => part.length === 0)
  ) {
    return null;
  }
  return confinedPath(path);
}

import { parse } from 'yaml';

/**
 * Frontmatter parsing for the skill/command markdown files the CLIs discover
 * on disk (`SKILL.md` under a skills directory, `*.md` under a commands
 * directory). Pure — the SkillsService does the directory walking.
 *
 * Tolerance is deliberate here: these files are authored by the user (or by
 * third-party skill packs), so a malformed frontmatter block degrades to
 * "no metadata" instead of erroring — one broken file must never take the
 * whole composer autocomplete down.
 */

/** Sanity cap on a wire description — the composer row truncates visually. */
const MAX_DESCRIPTION_LENGTH = 300;

/** An invokable `/name` token: no whitespace, no path separators. */
const VALID_NAME = /^[^\s/\\]+$/;

/** What one markdown file contributes to the autocomplete list. */
export interface SkillMeta {
  name: string;
  description: string | null;
}

/** Split a leading `--- … ---` YAML frontmatter block off the body. */
function splitFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  const body = content.slice(match[0].length);
  let data: unknown;
  try {
    data = parse(match[1]!);
  } catch {
    return { frontmatter: {}, body };
  }
  const frontmatter =
    typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  return { frontmatter, body };
}

/** Collapse to one bounded line; null when blank or not a string. */
function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    return null;
  }
  return collapsed.length > MAX_DESCRIPTION_LENGTH
    ? `${collapsed.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
    : collapsed;
}

/** The first candidate that is a typable `/name` token, else null. */
function pickName(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim();
    if (VALID_NAME.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

/**
 * Parse one `SKILL.md`: the name comes from frontmatter (falling back to the
 * skill's directory name), the description from frontmatter only — a skill
 * body is the instruction text, not a summary. Null when no usable name.
 */
export function parseSkillMd(
  content: string,
  fallbackName: string,
): SkillMeta | null {
  const { frontmatter } = splitFrontmatter(content);
  const name = pickName(frontmatter['name'], fallbackName);
  if (name === null) {
    return null;
  }
  return { name, description: normalizeText(frontmatter['description']) };
}

/**
 * Parse one command file (`<name>.md`): the name is the file stem, the
 * description comes from frontmatter, falling back to the body's first
 * non-empty line (its prompt opener) with heading markers stripped. Null when
 * the stem is not a typable token.
 */
export function parseCommandMd(
  content: string,
  fileStem: string,
): SkillMeta | null {
  const name = pickName(fileStem);
  if (name === null) {
    return null;
  }
  const { frontmatter, body } = splitFrontmatter(content);
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line.length > 0);
  const description =
    normalizeText(frontmatter['description']) ??
    normalizeText(firstLine) ??
    null;
  return { name, description };
}

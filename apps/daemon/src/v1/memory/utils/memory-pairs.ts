import { createHash } from 'node:crypto';

import { chatTextMatchQuery } from '../../agents/utils/chat-text-query';

/** The rarest words of an entry its partners are searched by. */
const RARE_TERMS = 8;
/** Shorter words are mostly grammar, in English and Russian alike. */
const TERM_MIN_CHARS = 4;

interface Scoped {
  projectId: string | null;
  teamSlug: string | null;
}

/** The text a check judged, pinned: an edit changes it, a forget or a restore does not. */
export function memoryTextHash(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n${body}`).digest('hex');
}

/** The distinct words of an entry's title and body that a rarity count weighs. */
export function termsOf(title: string, body: string): Set<string> {
  return new Set(
    `${title} ${body}`
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(
        (word) => [...word].length >= TERM_MIN_CHARS && !/^\p{N}+$/u.test(word),
      ),
  );
}

/**
 * An FTS5 query for entries sharing any of `terms`' rarest words that another
 * entry also holds, or null when none is shared: a word only this entry holds
 * finds nothing.
 */
export function rareTermsQuery(
  terms: ReadonlySet<string>,
  entriesWith: ReadonlyMap<string, number>,
): string | null {
  const rare = [...terms]
    .filter((term) => (entriesWith.get(term) ?? 0) >= 2)
    .sort(
      (a, b) =>
        (entriesWith.get(a) ?? 0) - (entriesWith.get(b) ?? 0) ||
        a.localeCompare(b),
    )
    .slice(0, RARE_TERMS);
  return rare.length === 0 ? null : chatTextMatchQuery(rare.join(' OR '));
}

/**
 * Whether some run sees both entries: a global one beside anything, two of
 * one project, or two of one team. Entries of two projects never meet, so
 * they cannot conflict for any agent.
 */
export function seenTogether(a: Scoped, b: Scoped): boolean {
  const aGlobal = a.projectId === null && a.teamSlug === null;
  const bGlobal = b.projectId === null && b.teamSlug === null;
  if (aGlobal || bGlobal) {
    return true;
  }
  if (a.teamSlug !== null || b.teamSlug !== null) {
    return a.teamSlug === b.teamSlug;
  }
  return a.projectId === b.projectId;
}

/** A pair in stored order: the lower id first. */
export function orderedPair(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

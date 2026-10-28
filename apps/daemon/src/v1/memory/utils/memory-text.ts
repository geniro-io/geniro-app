import {
  chatTextMatchQuery,
  chatTextQueryTerms,
} from '../../agents/utils/chat-text-query';

/** Below this share of words in common, two titles are different notes. */
const DUPLICATE_TITLE_OVERLAP = 0.6;

const EXCERPT_CHARS = 160;

/** A title's distinct words, lowercased, split the way the FTS tokenizer splits. */
export function titleWords(title: string): Set<string> {
  return new Set(chatTextQueryTerms(title).filter((word) => word.length > 1));
}

/**
 * An FTS5 query for entries whose TITLE shares any word with `title`, or null
 * when it has none — the candidate set {@link similarTitles} then narrows.
 */
export function titleCandidatesQuery(title: string): string | null {
  const words = [...titleWords(title)];
  if (words.length === 0) {
    return null;
  }
  const any = chatTextMatchQuery(words.join(' OR '));
  return any === null ? null : `title : (${any})`;
}

/** Whether two titles say the same thing: most of their words in common. */
export function similarTitles(a: string, b: string): boolean {
  const left = titleWords(a);
  const right = titleWords(b);
  if (left.size === 0 || right.size === 0) {
    return false;
  }
  let common = 0;
  for (const word of left) {
    if (right.has(word)) {
      common += 1;
    }
  }
  return common / new Set([...left, ...right]).size >= DUPLICATE_TITLE_OVERLAP;
}

/** The start of a body on one line, for a search hit. */
export function excerptOf(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_CHARS
    ? flat
    : `${flat.slice(0, EXCERPT_CHARS - 1)}…`;
}

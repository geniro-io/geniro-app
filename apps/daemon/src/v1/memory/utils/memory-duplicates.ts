import { chatTextMatchQuery } from '../../agents/utils/chat-text-query';
import { ruleOfLessonBody } from './lesson-body';
import { termsOf } from './memory-pairs';

/**
 * At or above this cosine of two notes' words they say the same thing: on the
 * real store, pairs above it were paraphrases of one note, and below it
 * related notes saying different things start to outnumber them.
 */
export const NEAR_DUPLICATE_SIMILARITY = 0.42;

/** Fewer words in common than this never make a duplicate, however short both notes are. */
export const NEAR_DUPLICATE_MIN_SHARED_WORDS = 3;

/** The most of a new note's words its candidates are searched by. */
const CANDIDATE_TERMS = 64;

export interface NoteText {
  title: string;
  body: string;
}

/**
 * An FTS5 query for entries sharing any of a note's words, its title's first
 * and then its longest, or null when it has none.
 */
export function nearDuplicateCandidatesQuery(note: NoteText): string | null {
  const title = termsOf(note.title, '');
  const parts = [...wordsOf(note)]
    .sort(
      (a, b) =>
        Number(title.has(b)) - Number(title.has(a)) ||
        b.length - a.length ||
        a.localeCompare(b),
    )
    .slice(0, CANDIDATE_TERMS)
    .map(chatTextMatchQuery)
    .filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(' OR ');
}

/**
 * How many distinct words two notes share, and the cosine of their word sets
 * (0 when either has none). A lesson's body counts only its rule.
 */
export function textSimilarity(
  a: NoteText,
  b: NoteText,
): { shared: number; cosine: number } {
  const left = wordsOf(a);
  const right = wordsOf(b);
  let shared = 0;
  for (const word of left) {
    if (right.has(word)) {
      shared += 1;
    }
  }
  return {
    shared,
    cosine: shared === 0 ? 0 : shared / Math.sqrt(left.size * right.size),
  };
}

function wordsOf(note: NoteText): Set<string> {
  return termsOf(note.title, ruleOfLessonBody(note.body));
}

export function nearDuplicate(a: NoteText, b: NoteText): boolean {
  const { shared, cosine } = textSimilarity(a, b);
  return (
    shared >= NEAR_DUPLICATE_MIN_SHARED_WORDS &&
    cosine >= NEAR_DUPLICATE_SIMILARITY
  );
}

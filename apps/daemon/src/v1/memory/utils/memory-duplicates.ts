import { chatTextMatchQuery } from '../../agents/utils/chat-text-query';
import { ruleOfLessonBody } from './lesson-body';
import { termsOf } from './memory-pairs';

/**
 * At or above this cosine of two notes' words they say the same thing: on the
 * real store, pairs above it were paraphrases of one note, and below it
 * related notes saying different things start to outnumber them.
 */
export const NEAR_DUPLICATE_SIMILARITY = 0.42;

/** Fewer words in common than this never make a duplicate, however short both notes are, unless they are exact copies. */
export const NEAR_DUPLICATE_MIN_SHARED_WORDS = 3;

/** The most of a new note's words its candidates are searched by. */
const CANDIDATE_TERMS = 64;

export interface NoteText {
  title: string;
  body: string;
}

/**
 * An FTS5 query for entries sharing any of a note's words, its title's first
 * and then its longest — every word of any length when none is long enough to
 * count, so an exact copy is still found — or null when it has none.
 */
export function nearDuplicateCandidatesQuery(note: NoteText): string | null {
  const title = termsOf(note.title, '');
  const counted = wordsOf(note);
  const words =
    counted.size > 0
      ? counted
      : new Set([
          ...wordSequenceOf(note.title),
          ...wordSequenceOf(ruleOfLessonBody(note.body)),
        ]);
  const parts = [...words]
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

function wordSequenceOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Whether two notes have the same words in the same order, in title and body, ignoring case and punctuation. */
export function sameText(a: NoteText, b: NoteText): boolean {
  const left = wordSequenceOf(a.title);
  const right = wordSequenceOf(b.title);
  const leftBody = wordSequenceOf(ruleOfLessonBody(a.body));
  const rightBody = wordSequenceOf(ruleOfLessonBody(b.body));
  return (
    left.length + leftBody.length > 0 &&
    left.join(' ') === right.join(' ') &&
    leftBody.join(' ') === rightBody.join(' ')
  );
}

export function nearDuplicate(a: NoteText, b: NoteText): boolean {
  if (sameText(a, b)) {
    return true;
  }
  const { shared, cosine } = textSimilarity(a, b);
  return (
    shared >= NEAR_DUPLICATE_MIN_SHARED_WORDS &&
    cosine >= NEAR_DUPLICATE_SIMILARITY
  );
}

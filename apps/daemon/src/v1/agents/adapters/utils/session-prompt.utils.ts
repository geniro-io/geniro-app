import type { SessionResumability } from '../adapter.types';

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * What a session whose saved user messages are `userTexts` holds of the last
 * of `prompts`, the briefs of a thread's calls oldest first. A CLI may wrap a
 * prompt (host context, its own tags) or re-flow its whitespace, so a saved
 * message that contains it as whole words counts. Each brief is looked for
 * after the message holding the one before it, so a CLI's own context message
 * or an earlier identical brief cannot stand in for the last; an earlier brief
 * found nowhere (a call cut off before its CLI saved it) is passed over.
 */
export function sessionResumabilityOf(
  userTexts: readonly string[],
  prompts: readonly string[],
): SessionResumability {
  if (userTexts.length === 0) {
    return 'unsaved';
  }
  const wanted = prompts.map(squashWhitespace).filter((text) => text !== '');
  const asked = wanted.pop();
  if (asked === undefined) {
    return 'resumable';
  }
  const saved = userTexts.map(squashWhitespace);
  let from = 0;
  for (const earlier of wanted) {
    const at = savedIndexOf(saved, earlier, from);
    if (at !== -1) {
      from = at + 1;
    }
  }
  return savedIndexOf(saved, asked, from) === -1
    ? 'prompt-missing'
    : 'resumable';
}

function savedIndexOf(
  saved: readonly string[],
  wanted: string,
  from: number,
): number {
  for (let at = from; at < saved.length; at += 1) {
    if (holdsWords(saved[at]!, wanted)) {
      return at;
    }
  }
  return -1;
}

function holdsWords(text: string, wanted: string): boolean {
  const opensWord = WORD_CHAR.test(wanted[0]!);
  const closesWord = WORD_CHAR.test(wanted.at(-1)!);
  for (
    let start = text.indexOf(wanted);
    start !== -1;
    start = text.indexOf(wanted, start + 1)
  ) {
    const end = start + wanted.length;
    if (
      (!opensWord || start === 0 || !WORD_CHAR.test(text[start - 1]!)) &&
      (!closesWord || end === text.length || !WORD_CHAR.test(text[end]!))
    ) {
      return true;
    }
  }
  return false;
}

function squashWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

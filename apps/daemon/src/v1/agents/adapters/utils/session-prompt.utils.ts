import type { SessionResumability } from '../adapter.types';

/**
 * What a session whose saved user messages are `userTexts` holds of
 * `prompt`. A CLI may wrap the prompt (host context, its own tags) or
 * re-flow its whitespace, so a saved message that contains it counts.
 */
export function sessionResumabilityOf(
  userTexts: readonly string[],
  prompt: string | null,
): SessionResumability {
  if (userTexts.length === 0) {
    return 'unsaved';
  }
  if (prompt === null) {
    return 'resumable';
  }
  const wanted = squashWhitespace(prompt);
  return userTexts.some((text) => squashWhitespace(text).includes(wanted))
    ? 'resumable'
    : 'prompt-missing';
}

function squashWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

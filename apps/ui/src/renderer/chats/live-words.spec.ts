import { describe, expect, it } from 'vitest';

import { COMPOSING_WORDS, THINKING_WORDS, WORKING_WORDS } from './live-words';
import { STANDING_ACTIVITY } from './run-status';

describe('the live vocabularies', () => {
  it('opens the working list on the app’s own standing phrase', () => {
    // TWINNED: `run-status.tsx` spells the same fallback with its ellipsis for
    // the sidebar badge, this list without one because the row appends its own.
    // The sidebar and the transcript are two renderings of ONE run, so a row
    // that opened on a word the badge beside it never says would be a third
    // spelling of one state — the defect the status table exists to prevent.
    expect(`${WORKING_WORDS[0]}…`).toBe(STANDING_ACTIVITY);
  });

  it('opens the thinking list on the plain word', () => {
    // The rule every list follows: the canonical word first, so a short wait
    // and a screenshot of one read exactly as they always have, and the whimsy
    // is never the first thing a new user meets.
    expect(THINKING_WORDS[0]).toBe('Thinking');
    expect(COMPOSING_WORDS[0]).toBe('Composing');
  });

  it('holds enough words to be worth rotating, with no repeats', () => {
    // A repeat reads as the row having reset — the rotation is the one signal
    // that separates a slow turn from a hung one, so it must not appear to go
    // backwards. Two entries would be a blink rather than a vocabulary.
    for (const words of [THINKING_WORDS, WORKING_WORDS, COMPOSING_WORDS]) {
      expect(words.length).toBeGreaterThan(4);
      expect(new Set(words).size).toBe(words.length);
    }
  });

  it('carries no punctuation of its own', () => {
    // Every call site appends its own ellipsis, and the call block lower-cases
    // its word into a sentence. A word carrying a trailing `…` or a capital
    // mid-phrase would break one of the two.
    for (const words of [THINKING_WORDS, WORKING_WORDS, COMPOSING_WORDS]) {
      for (const word of words) {
        expect(word).not.toMatch(/[.…]/);
        expect(word.trim()).toBe(word);
      }
    }
  });
});

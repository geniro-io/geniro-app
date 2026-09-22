import { useEffect, useState } from 'react';

/**
 * The word a live row uses for "still going", and the clock that changes it.
 *
 * A long wait told in one fixed word reads as a frozen screen: `Working… · 4m
 * 12s` is the same sentence at four minutes as at four seconds, so the only
 * thing moving is a number nobody watches. Claude Code answers that with a
 * rotating vocabulary, and this is geniro's — the point is not the joke, it is
 * that the row visibly CHANGES, which is the one thing that separates a slow
 * turn from a hung one at a glance.
 *
 * THE FIRST WORD OF EVERY LIST IS THE PLAIN ONE, and that is a rule rather
 * than an ordering accident. A row renders its canonical word — `Thinking`,
 * `Working` — and only starts wandering once the wait has lasted long enough
 * to be worth entertaining, so a screenshot of a two-second turn says exactly
 * what it used to and the whimsy is never the FIRST thing a new user reads.
 * It is also what keeps the app's own status vocabulary honest: the sidebar
 * badge and the chat header say `working`, and a transcript row that opened on
 * `Marshalling` would be the third spelling of one state.
 */

/** How long one word stays on screen. */
const WORD_CYCLE_MS = 2_800;

/**
 * Words for a REASONING stretch — the agent is deliberating and has produced
 * nothing yet.
 *
 * All gerunds, all about thought rather than labour, so the two lists below
 * cannot be told apart only by their punctuation. Nothing here claims a
 * specific activity (`Compiling`, `Searching`): the row does not know what the
 * agent is doing, and a word that guessed would be the one thing on the screen
 * stating something nobody measured.
 */
export const THINKING_WORDS: readonly string[] = [
  'Thinking',
  'Pondering',
  'Ruminating',
  'Mulling',
  'Deliberating',
  'Percolating',
  'Cogitating',
  'Puzzling',
  'Noodling',
  'Reasoning',
  'Weighing',
  'Musing',
  'Untangling',
  'Contemplating',
  'Reckoning',
  'Deducing',
  'Chewing it over',
  'Turning it over',
];

/**
 * Words for a WORKING stretch — the agent is busy and the daemon has not named
 * what it is doing.
 *
 * Only ever the FALLBACK. When the daemon says `running Bash`, that phrase
 * wins: a real answer always beats a decorative one, and the whole reason the
 * activity announce exists is that an abstract label leaves the user unable to
 * tell a long compaction from a hung tool.
 *
 * The FIRST entry is TWINNED with `run-status.tsx`'s `STANDING_ACTIVITY` — the
 * same fallback, written once with its ellipsis for the sidebar badge and once
 * without for a row that appends its own. The sidebar and the transcript are
 * two renderings of one run, so a row opening on a word the badge beside it
 * never says is the "давай стандартизируем статусы" report from a new angle.
 * `live-words.spec.ts` fails if the two drift.
 */
export const WORKING_WORDS: readonly string[] = [
  'Working',
  'Tinkering',
  'Wrangling',
  'Assembling',
  'Crunching',
  'Whittling',
  'Finessing',
  'Tuning',
  'Forging',
  'Shuffling',
  'Conjuring',
  'Orchestrating',
  'Sculpting',
  'Brewing',
  'Rummaging',
  'Marshalling',
  'Beavering away',
  'Getting on with it',
];

/**
 * Words for a card being WRITTEN — the model is serializing a host tool's
 * arguments and the card has not landed yet.
 *
 * Its own list because the two above describe a state and this one describes
 * an ACT with a known object: the row reads `Drafting a chart`, so a word that
 * works beside `a chart` is a different set from one that stands alone.
 */
export const COMPOSING_WORDS: readonly string[] = [
  'Composing',
  'Drafting',
  'Assembling',
  'Laying out',
  'Shaping',
  'Building',
  'Arranging',
  'Sketching',
  'Crafting',
  'Piecing together',
];

/** Whether this machine has asked for less motion. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * The word to show right now, changing every {@link WORD_CYCLE_MS}.
 *
 * Three properties are load-bearing.
 *
 * The FIRST RENDER is always `words[0]`, so a spec that renders a row and reads
 * it immediately sees the canonical word, and so does a user whose turn is over
 * in a second. Rotation begins on the first tick.
 *
 * After that the list is walked from a PER-ROW offset, and each row's clock is
 * started at a random PHASE inside the cycle. Both halves are needed and they
 * answer different halves of the same problem. Every live row on screen mounts
 * in the same commit, so a shared period had all of them change together —
 * MEASURED in the running renderer with eleven rows up: each word is keyed, so
 * each new one plays a 260ms fade-in, and a screenshot landing in that window
 * caught every row on the page mid-fade at once. Eleven labels blinking in
 * unison reads as the app glitching rather than as agents working; staggered,
 * at most one is ever mid-change. The offset picks WHICH word and the phase
 * picks WHEN, and neither substitutes for the other.
 *
 * Both are drawn once at mount and never re-drawn, or the word would change on
 * every render.
 *
 * Under `prefers-reduced-motion` it never advances. Honoured rather than
 * decorative, exactly as `.title-naming` is: the row is perfectly legible at
 * `Working`, and a reader who asked for stillness is not asking to be denied
 * the status.
 */
export function useLiveWord(words: readonly string[]): string {
  const [ticks, setTicks] = useState(0);
  // `useState`'s initializer form: drawn ONCE for this row's lifetime. Computed
  // inline it would re-roll on every render and the word would flicker.
  const [offset] = useState(() => Math.floor(Math.random() * words.length));
  const [phase] = useState(() => Math.floor(Math.random() * WORD_CYCLE_MS));
  useEffect(() => {
    if (words.length < 2 || prefersReducedMotion()) {
      return;
    }
    // A timeout into the cycle, THEN the steady interval — which is what puts
    // this row's changes out of step with its neighbours' for good, rather than
    // only delaying the first one.
    let interval = 0;
    const advance = (): void => setTicks((n) => n + 1);
    const start = window.setTimeout(() => {
      advance();
      interval = window.setInterval(advance, WORD_CYCLE_MS);
    }, phase);
    return () => {
      window.clearTimeout(start);
      window.clearInterval(interval);
    };
  }, [words, phase]);
  if (ticks === 0 || words.length < 2) {
    return words[0] ?? '';
  }
  // The plain word is skipped once rotation has begun — it has already been
  // shown, and coming back to it mid-wait reads as the row having reset.
  return words[1 + ((offset + ticks - 1) % (words.length - 1))] ?? words[0]!;
}

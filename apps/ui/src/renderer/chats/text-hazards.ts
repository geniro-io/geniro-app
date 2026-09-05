/**
 * Detects hazardous Unicode characters in a string WITHOUT ever exposing the
 * characters themselves — a caller renders each hit's CLASS and CODEPOINT
 * (`U+202E`), never the character, because the class this exists to catch
 * (bidi overrides) can reorder or disguise the very warning meant to display
 * it.
 *
 * Three classes:
 *  - `bidi` — a directional-formatting control that can silently reorder
 *    surrounding text on screen, letting a patch or command LOOK different
 *    from what it does.
 *  - `invisible` — a format, control or default-ignorable character. NOT every
 *    glyph that renders blank: U+2800 BRAILLE BLANK and the space separators
 *    are `So`/`Zs` and are deliberately out of scope, since they occupy width
 *    and do not hide adjacent text.
 *  - `mixedScript` — a token that reads as one word while mixing look-alike
 *    letters from two different scripts (a homograph substitution), found
 *    WITHOUT a confusables table — see `mixedScriptHitIn` for why.
 *
 * CALLER CONTRACT: `\p{Cc}` includes tab, newline and carriage return, so a
 * caller passing RAW multi-line text gets a hit per line break. Pass text whose
 * ordinary control characters are already escaped (a compact `JSON.stringify`
 * does this), or expect every multi-line input to report as hazardous.
 */

export type HazardClass = 'bidi' | 'invisible' | 'mixedScript';

export interface HazardHit {
  class: HazardClass;
  /** The Unicode code point as a NUMBER (e.g. `0x202e`), never the character. */
  codePoint: number;
  /** UTF-16 index into the scanned string. */
  offset: number;
}

export interface HazardScanResult {
  hits: HazardHit[];
  /**
   * True when a `bidi` or `invisible` hit is present. `mixedScript` alone
   * never gates: a token can be genuine foreign-language text sitting next to
   * English, where the other two classes have no such innocent reading.
   */
  gates: boolean;
}

/**
 * `\p{Bidi_Control}` is a spec-mandated BINARY Unicode property — exactly the
 * codepoints the bidi algorithm treats as directional-formatting controls
 * (12 of them on Unicode 16 / Node 24: U+061C, U+200E, U+200F, U+202A–202E,
 * U+2066–2069), a strict superset of any hand-written list and the
 * authoritative source rather than one drifting the moment Unicode adds one.
 */
const BIDI_PATTERN = /\p{Bidi_Control}/gu;

/**
 * Cf ∪ Default_Ignorable_Code_Point ∪ Cc, MINUS the bidi set, so a bidi
 * control is reported once as `bidi` and never a second time as `invisible`.
 * The `/v` flag's set-difference (`--`) computes that subtraction as one
 * class rather than two passes reconciled by hand — confirmed working on
 * this repo's Node (v24).
 */
const INVISIBLE_PATTERN =
  /[[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Cc}]--\p{Bidi_Control}--\p{Variation_Selector}]/gv;

/**
 * A ZERO WIDTH JOINER between two pictographs is an emoji sequence, not a
 * hidden join — `👩‍💻` is one glyph built from two plus this character.
 *
 * It is exempted by CONTEXT rather than removed from the class, because the
 * same codepoint between LETTERS is a real hazard: it splits a word into pieces
 * that render as one. Variation selectors need no such test — they only ever
 * follow a base character to pick its presentation, so they are subtracted from
 * the class outright above.
 *
 * The exemption exists because the gate is only worth having if it stays rare.
 * `\p{Default_Ignorable_Code_Point}` covers VS16 and ZWJ, so before this an
 * ordinary `⚠️` or `👩‍💻` in a proposed patch disabled Approve behind the red
 * banner — and a warning that fires on routine text is one people learn to tick
 * through, which costs more than it protects.
 */
const ZERO_WIDTH_JOINER = 0x200d;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
/**
 * A base emoji is routinely followed by a SKIN-TONE modifier or a VS16 before
 * the joiner reaches it — `👩🏽‍💻` and `🏳️‍🌈` are the everyday cases — and
 * neither of those characters is itself `Extended_Pictographic`. Reading the
 * immediately-adjacent codepoint therefore answered "not an emoji" for exactly
 * the sequences people paste most, so the two commonest emoji shapes on the
 * planet gated Approve. These are skipped over to reach the base.
 */
const EMOJI_SUFFIX = /[\p{Emoji_Modifier}\p{Variation_Selector}]/u;

function pictographBeside(chars: readonly string[]): boolean {
  for (const char of chars) {
    if (EMOJI_SUFFIX.test(char)) {
      continue;
    }
    return PICTOGRAPHIC.test(char);
  }
  return false;
}

function joinsTwoPictographs(text: string, offset: number): boolean {
  const before = [...text.slice(0, offset)].reverse();
  const after = [...text.slice(offset + 1)];
  return pictographBeside(before) && pictographBeside(after);
}

/**
 * A run of letters/marks/numbers/connector-punctuation — the closest a regex
 * gets to "one word". Numbers and connectors stay INSIDE a token (an
 * identifier like `old_string2` is one word) rather than splitting it, while
 * ordinary punctuation and whitespace are left out entirely and so already
 * act as token boundaries.
 */
const TOKEN_PATTERN = /[\p{L}\p{M}\p{N}\p{Pc}]+/gu;

type MixedScriptTag = 'Latin' | 'Cyrillic' | 'Greek';

const SCRIPT_PATTERNS: readonly { tag: MixedScriptTag; pattern: RegExp }[] = [
  { tag: 'Latin', pattern: /\p{Script_Extensions=Latin}/u },
  { tag: 'Cyrillic', pattern: /\p{Script_Extensions=Cyrillic}/u },
  { tag: 'Greek', pattern: /\p{Script_Extensions=Greek}/u },
];

/**
 * Which of the three tracked scripts a single character belongs to, or null
 * for every character Common/Inherited already covers — digits, punctuation,
 * combining marks with no script of their own — which is what keeps them out
 * of the mixing count without a separate exclusion list.
 */
function scriptOf(char: string): MixedScriptTag | null {
  const found = SCRIPT_PATTERNS.find(({ pattern }) => pattern.test(char));
  return found ? found.tag : null;
}

/**
 * The minority-script hit inside one already-mixed token, or null when it
 * does not mix Latin with Cyrillic or Greek — the ONLY combination treated as
 * a hazard here (Cyrillic mixed with Greek and no Latin present is not
 * flagged; Latin is the script the reader is assumed to expect, so a stray
 * look-alike in either direction — Cyrillic-in-Latin or Latin-in-Cyrillic —
 * is what gets reported).
 *
 * "Minority" is by COUNT: a token that is mostly Cyrillic with one stray
 * Latin letter reports that Latin letter, not the Cyrillic majority. A tie
 * is broken by whichever tied script's character comes FIRST in the token,
 * which keeps the result deterministic without inventing a second rule.
 */
function mixedScriptHitIn(
  token: string,
  tokenOffset: number,
): HazardHit | null {
  const chars: {
    char: string;
    offset: number;
    script: MixedScriptTag | null;
  }[] = [];
  let cursor = tokenOffset;
  for (const char of token) {
    chars.push({ char, offset: cursor, script: scriptOf(char) });
    cursor += char.length;
  }
  const counts = new Map<MixedScriptTag, number>();
  for (const { script } of chars) {
    if (script) {
      counts.set(script, (counts.get(script) ?? 0) + 1);
    }
  }
  const hasLatin = (counts.get('Latin') ?? 0) > 0;
  const hasCyrillicOrGreek =
    (counts.get('Cyrillic') ?? 0) > 0 || (counts.get('Greek') ?? 0) > 0;
  if (!hasLatin || !hasCyrillicOrGreek) {
    return null;
  }
  const minCount = Math.min(...counts.values());
  for (const { char, offset, script } of chars) {
    if (script && counts.get(script) === minCount) {
      const codePoint = char.codePointAt(0);
      // A char produced by iterating a string is never empty, so this is
      // always defined; the guard is here because `codePointAt` types it
      // optional and asserting would be the same claim with nothing checking
      // it.
      if (codePoint === undefined) {
        return null;
      }
      return { class: 'mixedScript', codePoint, offset };
    }
  }
  return null;
}

/** Every `bidi` or `invisible` hit matched by `pattern`, tagged `hazardClass`. */
function controlHits(
  text: string,
  pattern: RegExp,
  hazardClass: Extract<HazardClass, 'bidi' | 'invisible'>,
): HazardHit[] {
  const hits: HazardHit[] = [];
  for (const match of text.matchAll(pattern)) {
    const offset = match.index;
    const codePoint = match[0].codePointAt(0);
    // Both are typed optional by `matchAll`'s return shape, never actually
    // absent for a match this pattern can produce — the guard is here
    // because asserting would be the same claim with nothing checking it.
    if (offset === undefined || codePoint === undefined) {
      continue;
    }
    if (codePoint === ZERO_WIDTH_JOINER && joinsTwoPictographs(text, offset)) {
      continue;
    }
    hits.push({ class: hazardClass, codePoint, offset });
  }
  return hits;
}

/**
 * Scans `text` for the three hazard classes above and returns every hit —
 * class, codepoint, UTF-16 offset — plus whether the result gates.
 */
export function scanTextHazards(text: string): HazardScanResult {
  const hits: HazardHit[] = [
    ...controlHits(text, BIDI_PATTERN, 'bidi'),
    ...controlHits(text, INVISIBLE_PATTERN, 'invisible'),
  ];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    if (match.index === undefined) {
      continue;
    }
    const hit = mixedScriptHitIn(match[0], match.index);
    if (hit) {
      hits.push(hit);
    }
  }
  hits.sort((a, b) => a.offset - b.offset);
  return {
    hits,
    gates: hits.some(
      (hit) => hit.class === 'bidi' || hit.class === 'invisible',
    ),
  };
}

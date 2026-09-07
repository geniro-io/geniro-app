import { describe, expect, it } from 'vitest';

import { scanTextHazards } from './text-hazards';

// Every BIDI / INVISIBLE / CONTROL character below is built from its numeric
// codepoint via `String.fromCodePoint`, never typed as a literal byte: the
// repo's pre-commit hook refuses any staged .ts/.tsx whose blob git
// classifies as binary (a NUL in the first 8000 bytes), and a bidi override
// sitting literally in this file would itself reorder the source around it.
// A codepoint constant is the same code unit at runtime as the raw byte, so
// the test is identical either way. Ordinary Cyrillic/Greek LETTERS used for
// the mixedScript cases are plain printable text — not control/format
// characters — and are written literally, since seeing the actual
// look-alike is the point of those cases.

const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const NUL = String.fromCodePoint(0x0);
const CYRILLIC_A = String.fromCodePoint(0x0430); // visually "a"
const GREEK_ALPHA = String.fromCodePoint(0x0391); // visually "A"

describe('scanTextHazards', () => {
  it('reports a right-to-left override as bidi with its codepoint and offset', () => {
    const result = scanTextHazards(`hello ${RIGHT_TO_LEFT_OVERRIDE}world`);
    const hit = result.hits.find((h) => h.class === 'bidi');
    expect(hit?.codePoint).toBe(8238); // 0x202e
    expect(hit?.offset).toBe(6); // UTF-16 index of the override, after "hello "
  });

  it('reports a zero-width space as invisible', () => {
    const result = scanTextHazards(`a${ZERO_WIDTH_SPACE}b`);
    const hit = result.hits.find((h) => h.class === 'invisible');
    expect(hit?.class).toBe('invisible');
    expect(hit?.codePoint).toBe(0x200b);
    expect(hit?.offset).toBe(1);
  });

  it('reports a NUL control character as invisible', () => {
    // `\p{Cc}` is the third leg of the invisible set, distinct from the `\p{Cf}`
    // a zero-width space belongs to — this pins that leg independently.
    const result = scanTextHazards(`fix${NUL}bug`);
    const hit = result.hits.find((h) => h.class === 'invisible');
    expect(hit?.codePoint).toBe(0);
    expect(hit?.offset).toBe(3);
  });

  it('never double-reports a bidi codepoint as also invisible', () => {
    // Every one of the 12 Bidi_Control codepoints on Unicode 16 (Node 24) is
    // ALSO a Format character (`\p{Cf}`), so without the `/v` set-difference
    // subtracting the bidi set from the invisible one, each of these would
    // produce two hits instead of one — this is what actually exercises the
    // `--` in `[[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Cc}]--\p{Bidi_Control}]`
    // rather than merely asserting a count.
    const bidiCodepoints = [
      0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066,
      0x2067, 0x2068, 0x2069,
    ];
    for (const codePoint of bidiCodepoints) {
      const result = scanTextHazards(String.fromCodePoint(codePoint));
      // Asserted as one object so the failing DIFF names which codepoint
      // regressed — a bare length check reports `expected 1, got 2` with
      // nothing saying which of the twelve it was.
      const label = `U+${codePoint.toString(16).toUpperCase()}`;
      expect({
        label,
        count: result.hits.length,
        class: result.hits[0]?.class,
      }).toEqual({ label, count: 1, class: 'bidi' });
    }
  });

  it('flags a Latin token carrying one Cyrillic character as mixedScript', () => {
    // A classic PayPal-style homograph: the "a" in "paypal" is really
    // CYRILLIC SMALL LETTER A, visually identical to Latin "a" in most fonts.
    const result = scanTextHazards(`p${CYRILLIC_A}ypal`);
    const hit = result.hits.find((h) => h.class === 'mixedScript');
    expect(hit?.codePoint).toBe(0x0430);
    expect(hit?.offset).toBe(1);
  });

  it('flags a Latin token carrying one Greek character as mixedScript', () => {
    const result = scanTextHazards(`${GREEK_ALPHA}pple`);
    const hit = result.hits.find((h) => h.class === 'mixedScript');
    expect(hit?.codePoint).toBe(0x0391);
    expect(hit?.offset).toBe(0);
  });

  it('reports the minority script by COUNT, not by which side is Latin', () => {
    // A mostly-Cyrillic token with one stray Latin letter must name the Latin
    // outlier, not the Cyrillic majority — pins that the rule is "fewer
    // characters", not "whichever script isn't Latin".
    const cyrillicWord = 'привет'; // Cyrillic, pure letters — safe to write literally
    const result = scanTextHazards(`${cyrillicWord}e`);
    const hit = result.hits.find((h) => h.class === 'mixedScript');
    expect(hit?.codePoint).toBe(0x65); // "e"
    expect(hit?.offset).toBe(cyrillicWord.length);
  });

  it('does not flag a purely-Cyrillic token', () => {
    // Known, accepted limit: whole-script confusables (a token that is
    // entirely one non-Latin script) are invisible to a MIXING check by
    // construction — there is nothing here for it to mix with.
    const result = scanTextHazards('привет');
    expect(result.hits.find((h) => h.class === 'mixedScript')).toBeUndefined();
  });

  it('does not flag a token mixing only Cyrillic and Greek, with no Latin', () => {
    // The spec's hazard is specifically Latin mixed with a look-alike, since
    // Latin is the script a reader is assumed to expect; two non-Latin
    // scripts sharing a token is outside that definition.
    const result = scanTextHazards(`${CYRILLIC_A}${GREEK_ALPHA}`);
    expect(result.hits.find((h) => h.class === 'mixedScript')).toBeUndefined();
  });

  it('does not count digits or punctuation toward a script mix', () => {
    // Common/Inherited characters (digits here) must stay script-neutral: a
    // token of Latin letters and digits alone is not "mixed" just because a
    // digit carries no script of its own.
    const result = scanTextHazards('paypal123');
    expect(result.hits).toHaveLength(0);
  });

  it('yields nothing for plain ASCII', () => {
    const result = scanTextHazards('const total = price * quantity;');
    expect(result.hits).toHaveLength(0);
    expect(result.gates).toBe(false);
  });

  it('gates on a bidi hit', () => {
    const result = scanTextHazards(`safe ${RIGHT_TO_LEFT_OVERRIDE} text`);
    expect(result.gates).toBe(true);
  });

  it('gates on an invisible hit', () => {
    const result = scanTextHazards(`safe${ZERO_WIDTH_SPACE}text`);
    expect(result.gates).toBe(true);
  });

  it('does not gate on a mixedScript-only result', () => {
    const result = scanTextHazards(`p${CYRILLIC_A}ypal`);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.gates).toBe(false);
  });

  it('stays quiet on ordinary emoji, so the gate keeps meaning something', () => {
    // `\p{Default_Ignorable_Code_Point}` covers the variation selector and the
    // zero-width joiner, so without the exemptions an agent writing a warning
    // sign or a person emoji in a patch would disable Approve behind the red
    // banner — and a stop that fires on routine text is one people learn to
    // tick through.
    const VS16 = String.fromCodePoint(0xfe0f);
    const ZWJ = String.fromCodePoint(0x200d);
    const WOMAN = String.fromCodePoint(0x1f469);
    const LAPTOP = String.fromCodePoint(0x1f4bb);

    expect(scanTextHazards(`Warning ⚠${VS16} here`).hits).toEqual([]);
    expect(scanTextHazards(`by ${WOMAN}${ZWJ}${LAPTOP}`).hits).toEqual([]);
  });

  it('stays quiet when a SKIN TONE or a VS16 stands between the base and the joiner', () => {
    // The two shapes people actually paste, and the reason the exemption walks
    // BACK over emoji suffixes instead of reading the adjacent codepoint: in
    // `👩🏽‍💻` the character before the joiner is U+1F3FD (Emoji_Modifier) and in
    // `🏳️‍🌈` it is U+FE0F — neither is `Extended_Pictographic`, so both gated
    // Approve behind the red banner while the un-modified `👩‍💻` beside them
    // passed. That is precisely the tick-through desensitization the exemption
    // exists to prevent, on its commonest inputs.
    const VS16 = String.fromCodePoint(0xfe0f);
    const ZWJ = String.fromCodePoint(0x200d);
    const WOMAN = String.fromCodePoint(0x1f469);
    const LAPTOP = String.fromCodePoint(0x1f4bb);
    const TONE = String.fromCodePoint(0x1f3fd);
    const WHITE_FLAG = String.fromCodePoint(0x1f3f3);
    const RAINBOW = String.fromCodePoint(0x1f308);

    expect(scanTextHazards(`by ${WOMAN}${TONE}${ZWJ}${LAPTOP}`).hits).toEqual(
      [],
    );
    expect(
      scanTextHazards(`${WHITE_FLAG}${VS16}${ZWJ}${RAINBOW} ok`).hits,
    ).toEqual([]);
  });

  it('still flags a zero-width joiner that splits a WORD', () => {
    // The same codepoint between letters is the hazard the exemption must not
    // cover: it renders as one word and is two.
    const ZWJ = String.fromCodePoint(0x200d);

    const result = scanTextHazards(`ad${ZWJ}min`);

    expect(result.hits.map((hit) => hit.class)).toEqual(['invisible']);
    expect(result.gates).toBe(true);
  });

  it('returns hits sorted by offset when several classes are present', () => {
    // The fixture is deliberately built so the NATURAL push order is DESCENDING:
    // the scan collects every invisible hit before it walks tokens, so the ZWSP
    // at offset 6 is pushed BEFORE the mixedScript hit at offset 1. Ordering the
    // fixture the other way round would leave the sort unexercised — the hits
    // would already come out ascending and deleting it would change nothing.
    const result = scanTextHazards(`p${CYRILLIC_A}ypal${ZERO_WIDTH_SPACE}`);

    // A literal, not a sorted copy of the result: comparing a list against its
    // own sort passes for every possible input.
    expect(result.hits.map((hit) => hit.offset)).toEqual([1, 6]);
  });
});

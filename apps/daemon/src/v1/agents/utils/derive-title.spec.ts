import { describe, expect, it } from 'vitest';

import { titleFromText } from './derive-title';

describe('titleFromText', () => {
  it('collapses a multi-line prompt onto one line', () => {
    expect(titleFromText('fix the\n\n  parser\tbug  ', 60)).toBe(
      'fix the parser bug',
    );
  });

  it('leaves text at exactly the ceiling untouched', () => {
    const text = 'a'.repeat(20);
    expect(titleFromText(text, 20)).toBe(text);
  });

  it('ellipsizes one character past the ceiling, staying within it', () => {
    const result = titleFromText('a'.repeat(21), 20);
    expect(result).toBe(`${'a'.repeat(19)}…`);
    // The ellipsis REPLACES a character rather than being appended to a full
    // line — the whole point of the -1, and what a caller sizing a column
    // depends on.
    expect(result).toHaveLength(20);
  });

  it('does not leave a dangling space before the ellipsis', () => {
    expect(titleFromText('some words here and more', 12)).toBe('some words…');
  });

  it('answers empty for text that is only whitespace', () => {
    expect(titleFromText('   \n\t ', 60)).toBe('');
  });

  it('never cuts an emoji in half at the boundary', () => {
    // `String.slice` counts UTF-16 units, so an astral character straddling
    // the cut leaves a lone surrogate that renders as the replacement glyph.
    const result = titleFromText(`${'a'.repeat(18)}😀tail`, 20);

    expect(result).toBe(`${'a'.repeat(18)}😀…`);
    // The emoji itself IS a surrogate pair, so the check is that none is
    // UNPAIRED — a half-sliced character is what renders as the replacement
    // glyph, not the presence of surrogates.
    expect(result.isWellFormed()).toBe(true);
  });

  it('strips control and bidi characters before measuring', () => {
    // Written as ESCAPES, never as literal bytes: a NUL in the first 8000
    // bytes makes git classify the file as binary, which the repo's pre-commit
    // hook refuses — and the escape and the raw byte are the same code unit at
    // runtime, so the test is identical either way.
    //
    // One source of this text is agent-generated, and neither a NUL bound for a
    // SQLite TEXT column nor a right-to-left override able to spoof a sidebar
    // row is caught by `\s`.
    expect(titleFromText('fix\u0000 the\u202E bug\u200B', 60)).toBe(
      'fix the bug',
    );
  });
});

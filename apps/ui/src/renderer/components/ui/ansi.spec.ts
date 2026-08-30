import { describe, expect, it } from 'vitest';

import { parseAnsi, stripAnsi } from './ansi';

/** `ESC` as an escape, never as the byte — see the module's own note. */
const ESC = '\u001b';
const sgr = (params: string): string => `${ESC}[${params}m`;

describe('parseAnsi', () => {
  it('leaves plain text as one unstyled run', () => {
    expect(parseAnsi('Ready in 812ms\n')).toEqual([
      {
        text: 'Ready in 812ms\n',
        color: null,
        bright: false,
        bold: false,
        dim: false,
        italic: false,
        underline: false,
      },
    ]);
  });

  it('reads a colour, and takes it back off at the reset', () => {
    const spans = parseAnsi(`ok ${sgr('31')}FAIL${sgr('0')} done`);
    expect(spans.map((s) => [s.text, s.color])).toEqual([
      ['ok ', null],
      ['FAIL', 'red'],
      [' done', null],
    ]);
  });

  it('applies each parameter of one sequence IN ORDER', () => {
    // `ESC[1;31m` is bold THEN red — one sequence carrying two independent
    // attributes, which a switch over the whole parameter string cannot read.
    const [span] = parseAnsi(`${sgr('1;31')}boom`);
    expect(span).toEqual(
      expect.objectContaining({ text: 'boom', color: 'red', bold: true }),
    );
  });

  it('takes `39` as the default colour without dropping the weight', () => {
    // The pair a tool actually emits around a word: colour on, colour off,
    // where `0` would also have cleared the bold it never set.
    const spans = parseAnsi(`${sgr('1')}${sgr('33')}warn${sgr('39')}!`);
    expect(spans.map((s) => [s.text, s.color, s.bold])).toEqual([
      ['warn', 'yellow', true],
      ['!', null, true],
    ]);
  });

  it('reads the BRIGHT half as the same eight names, FLAGGED bright', () => {
    // The name is shared and the brightness is a separate axis, because what
    // "brighter" looks like is a fact about the theme — the light theme lifts
    // only its greys, the dark theme all eight.
    expect(parseAnsi(`${sgr('92')}green`)[0]).toMatchObject({
      color: 'green',
      bright: true,
    });
    expect(parseAnsi(`${sgr('32')}green`)[0]).toMatchObject({
      color: 'green',
      bright: false,
    });
  });

  it('takes brightness off again with the colour that carried it', () => {
    // A stream that goes bright and then normal in the same colour must not
    // leave the brightness standing — `ESC[90m…ESC[30m` is what a tool emits
    // around a dimmed prefix, and a sticky flag would dim the rest of the line.
    const [, normal] = parseAnsi(`${sgr('92')}a${sgr('32')}b`);
    expect(normal).toMatchObject({ text: 'b', color: 'green', bright: false });
    const [, cleared] = parseAnsi(`${sgr('92')}a${sgr('39')}b`);
    expect(cleared).toMatchObject({ text: 'b', color: null, bright: false });
  });

  it('keeps a bright run and its normal twin as SEPARATE spans', () => {
    // They share the colour NAME, so a merge that compares only the name would
    // fold `ESC[90m12:04ESC[39;32m ok` into one span and draw the timestamp at
    // full strength — the exact defect the bright tokens exist to fix.
    const spans = parseAnsi(`${sgr('92')}bright${sgr('32')}normal`);
    expect(spans.map((s) => [s.text, s.bright])).toEqual([
      ['bright', true],
      ['normal', false],
    ]);
  });

  it('reads the first sixteen of the 256-colour palette, and no further', () => {
    expect(parseAnsi(`${ESC}[38;5;2mgreen`)[0]).toMatchObject({
      color: 'green',
      bright: false,
    });
    // 8–15 are the SAME eight again, bright — the palette's own layout, which
    // is why this is one index shift rather than a second table.
    expect(parseAnsi(`${ESC}[38;5;10mgreen`)[0]).toMatchObject({
      color: 'green',
      bright: true,
    });
    // The colour cube has no token to be drawn in, so the run takes the
    // surface's colour — and the parameters are still consumed, or `;208m`
    // would print as text.
    const [span] = parseAnsi(`${ESC}[38;5;208morange`);
    expect(span?.color).toBeNull();
    expect(span?.bright).toBe(false);
    expect(span?.text).toBe('orange');
  });

  it('consumes a 24-bit colour rather than printing its digits', () => {
    const [span] = parseAnsi(`${ESC}[38;2;255;0;0mred`);
    expect(span?.text).toBe('red');
    expect(span?.color).toBeNull();
  });

  it('drops the sequences it cannot honour instead of showing them', () => {
    // A spinner's erase-line, a cursor move, and a window title. Rendered as
    // text these are the visible junk the whole module exists to remove — the
    // escape byte is invisible in HTML and its tail is not.
    expect(stripAnsi(`${ESC}[2K${ESC}[1Gbuilding`)).toBe('building');
    expect(stripAnsi(`${ESC}]0;my title\u0007done`)).toBe('done');
  });

  it('plays a redrawn line out to what a terminal would be showing', () => {
    // One line, rewritten three times by a progress bar. Joined as text it
    // reads as all three at once.
    expect(stripAnsi('10%\r20%\r30%\ndone\n')).toBe('30%\ndone\n');
  });

  it('treats CRLF as a line ending, not as a redraw', () => {
    // The rule above, applied to a CRLF log, would keep only its last line.
    expect(stripAnsi('one\r\ntwo\r\n')).toBe('one\ntwo\n');
  });

  it('merges adjacent runs that share every attribute', () => {
    // A stream that resets between every word would otherwise produce one span
    // per word — a DOM the size of the log for no visible difference.
    expect(parseAnsi(`a${sgr('0')}b${sgr('39')}c`)).toHaveLength(1);
  });

  it('survives a truncated sequence at the end of a tail', () => {
    // The output is read as a bounded TAIL, so its first bytes can be the
    // middle of a sequence and its last can be the start of one.
    expect(stripAnsi(`fine${ESC}[3`)).toBe(`fine${ESC}[3`);
    expect(() => parseAnsi(`${ESC}`)).not.toThrow();
  });

  it('keeps the characters when it drops the codes', () => {
    expect(stripAnsi(`${sgr('1;32')}PASS${sgr('0')} 42 tests`)).toBe(
      'PASS 42 tests',
    );
  });
});

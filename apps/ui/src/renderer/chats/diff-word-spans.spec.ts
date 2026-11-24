import { describe, expect, it } from 'vitest';

import { changedSpans, differingSpans } from './diff-word-spans';

function marked(
  line: string,
  span: { start: number; end: number } | undefined,
): string {
  return span === undefined ? '' : line.slice(span.start, span.end);
}

describe('differingSpans', () => {
  it('marks the words that differ on each side, widened to whole words', () => {
    const before = '-const value = first + 1;';
    const after = '+const value = second + 1;';
    const [oldSpan, newSpan] = differingSpans(before, after);
    expect(marked(before, oldSpan)).toBe('first');
    expect(marked(after, newSpan)).toBe('second');
  });
});

describe('changedSpans', () => {
  it('pairs each removed line with the added line in the same place of the run after it', () => {
    const lines = [
      '-const a = one + 1;',
      '-const b = two + 1;',
      '+const a = uno + 1;',
      '+const b = dos + 1;',
    ];
    const spans = changedSpans(lines, ['removed', 'removed', 'added', 'added']);
    expect(marked(lines[0]!, spans.get(0))).toBe('one');
    expect(marked(lines[1]!, spans.get(1))).toBe('two');
    expect(marked(lines[2]!, spans.get(2))).toBe('uno');
    expect(marked(lines[3]!, spans.get(3))).toBe('dos');
  });

  it('leaves an extra removed line without an added partner unmarked', () => {
    const lines = [
      '-const a = one + 1;',
      '-const b = two + 1;',
      '+const a = uno + 1;',
    ];
    const spans = changedSpans(lines, ['removed', 'removed', 'added']);
    expect(spans.has(0)).toBe(true);
    expect(spans.has(1)).toBe(false);
    expect(spans.has(2)).toBe(true);
  });

  it('does not pair a removed line with an added line that is not directly after its run', () => {
    const lines = ['-const a = one + 1;', ' keep();', '+const a = uno + 1;'];
    const spans = changedSpans(lines, ['removed', 'other', 'added']);
    expect(spans.size).toBe(0);
  });

  it('marks nothing for a removed run with no added run after it', () => {
    const spans = changedSpans(
      ['-old one', '-old two'],
      ['removed', 'removed'],
    );
    expect(spans.size).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';

import { CappedTextBuffer, SCROLLBACK_CAP } from './capped-text-buffer';

describe('CappedTextBuffer', () => {
  it('replays what it was given, in order', () => {
    const buffer = new CappedTextBuffer();
    buffer.push('one ');
    buffer.push('two');

    expect(buffer.snapshot()).toBe('one two');
  });

  it('reports an empty write as a no-op so callers can skip publishing it', () => {
    // Both mirrors publish to attached clients only when this returns true; a
    // child flushing with nothing buffered must not wake every viewer.
    const buffer = new CappedTextBuffer();

    expect(buffer.push('')).toBe(false);
    expect(buffer.push('x')).toBe(true);
    expect(buffer.snapshot()).toBe('x');
  });

  it('drops the oldest chunks once it is over the cap', () => {
    const buffer = new CappedTextBuffer(10);
    buffer.push('OLDEST');
    buffer.push('12345');
    buffer.push('67890');

    expect(buffer.snapshot()).toBe('1234567890');
  });

  it('keeps a single over-cap chunk whole rather than emptying itself', () => {
    // The trim floors at one chunk on purpose: discarding it to satisfy the cap
    // would blank a mirror whose turn is actively producing output, which is
    // worse than briefly exceeding the ceiling.
    const buffer = new CappedTextBuffer(10);
    buffer.push('x'.repeat(50));

    expect(buffer.snapshot()).toHaveLength(50);
  });

  it('defaults to the one shared scrollback cap', () => {
    // The whole reason it is one constant: a panel must not hold a different
    // amount of history depending on which kind of mirror it opened.
    const buffer = new CappedTextBuffer();
    buffer.push('a');
    buffer.push('b'.repeat(SCROLLBACK_CAP));

    expect(buffer.snapshot()).toHaveLength(SCROLLBACK_CAP);
  });
});

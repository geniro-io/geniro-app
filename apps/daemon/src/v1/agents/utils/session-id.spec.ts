import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isPlainSessionId } from './session-id';

describe('isPlainSessionId', () => {
  it('accepts the ids the CLIs actually produce', () => {
    // Both shipped CLIs derive their ids from a filename, so a legitimate one
    // has no separator to lose — a guard that refused these would silently
    // break session import rather than protect anything.
    expect(isPlainSessionId('a1b2c3d4-0000-4000-8000-000000000001')).toBe(true);
    expect(isPlainSessionId('sess-1')).toBe(true);
  });

  it('refuses the two relative names, which are their own basename', () => {
    // The reason the basename comparison is not the whole test: measured,
    // `basename('..') === '..'`, so both pass it — and joined as a DIRECTORY
    // component they resolve outside the store they were meant to name.
    expect(basename('..')).toBe('..');
    expect(basename('.')).toBe('.');
    expect(isPlainSessionId('..')).toBe(false);
    expect(isPlainSessionId('.')).toBe(false);
  });

  it('refuses anything carrying a separator, and the empty string', () => {
    expect(isPlainSessionId('')).toBe(false);
    expect(isPlainSessionId('../outside')).toBe(false);
    expect(isPlainSessionId('a/b')).toBe(false);
    expect(isPlainSessionId('/etc/passwd')).toBe(false);
    expect(isPlainSessionId('sess-1/')).toBe(false);
  });

  it('leaves nothing that escapes when joined as a directory component', () => {
    // The property the guard exists for, asserted directly rather than through
    // the shapes above: whatever it admits must stay under the root.
    const root = '/store';
    const admitted = [
      'a1b2c3d4-0000-4000-8000-000000000001',
      'sess-1',
      '...',
      '..a',
      'a..',
      '~',
    ].filter(isPlainSessionId);

    for (const id of admitted) {
      expect(join(root, id, 'meta.json').startsWith(`${root}/`)).toBe(true);
    }
    // And the sample really did admit some — otherwise the loop proves nothing.
    expect(admitted.length).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from 'vitest';

import { stampEntry } from './handshake';

describe('stampEntry', () => {
  it('records the path with the file’s mtime and size', () => {
    expect(
      stampEntry('/bundle/daemon/dist/main.js', () => ({
        mtimeMs: 1_786_000_000_000,
        size: 8_508,
      })),
    ).toEqual({
      path: '/bundle/daemon/dist/main.js',
      mtimeMs: 1_786_000_000_000,
      size: 8_508,
    });
  });

  it('reports nulls — never a fabricated stamp — for a file it cannot read', () => {
    // The supervisor reads a null as "cannot confirm this is the current
    // build". A zero or a fallback timestamp here would instead compare EQUAL
    // to another unreadable stamp, which is the one wrong answer available:
    // two daemons neither of which can be identified would look identical.
    expect(
      stampEntry('/gone/main.js', () => {
        throw new Error('ENOENT');
      }),
    ).toEqual({ path: '/gone/main.js', mtimeMs: null, size: null });
  });
});

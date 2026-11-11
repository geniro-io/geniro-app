import { describe, expect, it } from 'vitest';

import { parsePressureLevel, readFreeDiskBytes } from './system-resources';

describe('parsePressureLevel', () => {
  it('reads the level sysctl prints', () => {
    expect(parsePressureLevel('4\n')).toBe(4);
    expect(parsePressureLevel('1')).toBe(1);
  });

  it('is null for anything that is not a level', () => {
    expect(parsePressureLevel('')).toBeNull();
    expect(parsePressureLevel('unknown oid')).toBeNull();
    expect(parsePressureLevel('2.5')).toBeNull();
  });
});

describe('readFreeDiskBytes', () => {
  it('reads the free space of the data volume, falling back to the root one', async () => {
    const free = await readFreeDiskBytes();
    expect(free).not.toBeNull();
    expect(free).toBeGreaterThan(0);
    expect(Number.isInteger(free)).toBe(true);
  });
});

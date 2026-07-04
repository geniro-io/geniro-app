import { describe, expect, it } from 'vitest';

import { safeEqual } from './safe-equal';

describe('safeEqual', () => {
  it('matches identical strings', () => {
    expect(safeEqual('Bearer tok-123', 'Bearer tok-123')).toBe(true);
    expect(safeEqual('', '')).toBe(true);
  });

  it('rejects same-length differences', () => {
    expect(safeEqual('tok-abc', 'tok-abd')).toBe(false);
  });

  it('rejects length mismatches without throwing (timingSafeEqual would)', () => {
    expect(safeEqual('short', 'a-much-longer-token')).toBe(false);
    expect(safeEqual('a-much-longer-token', 'short')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });

  it('compares bytes, not normalized unicode', () => {
    // U+00E9 vs e + U+0301 — equal under NFC, different byte sequences.
    expect(safeEqual('café', 'café')).toBe(false);
  });
});

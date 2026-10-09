import { describe, expect, it } from 'vitest';

import {
  msUntilPromptCacheNotice,
  PROMPT_CACHE_EXPIRING_MS,
  promptCacheState,
} from './prompt-cache';

const EXPIRES = '2026-10-09T11:00:00.000Z';
const at = Date.parse(EXPIRES);

describe('promptCacheState', () => {
  it('says nothing while the cache is comfortably warm', () => {
    expect(promptCacheState(EXPIRES, at - 30 * 60_000)).toBeNull();
  });

  it('counts down inside the last stretch before it lapses', () => {
    expect(promptCacheState(EXPIRES, at - 90_000)).toEqual({
      kind: 'expiring',
      remainingMs: 90_000,
    });
    // The boundary itself is inside the countdown.
    expect(promptCacheState(EXPIRES, at - PROMPT_CACHE_EXPIRING_MS)?.kind).toBe(
      'expiring',
    );
  });

  it('reports how long ago the cache lapsed', () => {
    expect(promptCacheState(EXPIRES, at + 12 * 60_000)).toEqual({
      kind: 'expired',
      sinceMs: 12 * 60_000,
    });
  });

  it('says nothing without a readable expiry — a CLI that reports no cache', () => {
    expect(promptCacheState(null, at)).toBeNull();
    expect(promptCacheState(undefined, at)).toBeNull();
    expect(promptCacheState('not a date', at)).toBeNull();
  });
});

describe('msUntilPromptCacheNotice', () => {
  it('sleeps until the countdown is due', () => {
    expect(msUntilPromptCacheNotice(EXPIRES, at - 30 * 60_000)).toBe(
      30 * 60_000 - PROMPT_CACHE_EXPIRING_MS,
    );
  });

  it('has nothing to wait for once the countdown has begun, or with no expiry', () => {
    expect(msUntilPromptCacheNotice(EXPIRES, at - 60_000)).toBeNull();
    expect(msUntilPromptCacheNotice(null, at)).toBeNull();
  });
});

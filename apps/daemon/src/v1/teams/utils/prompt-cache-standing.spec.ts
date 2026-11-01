import { describe, expect, it } from 'vitest';

import {
  advanceCacheClock,
  cacheExpiryOf,
  type ConversationCacheFacts,
  conversationFacts,
  isColdAndLarge,
  promptCacheStanding,
} from './prompt-cache-standing';

const HOUR = 60 * 60_000;

function facts(
  overrides: Partial<ConversationCacheFacts> = {},
): ConversationCacheFacts {
  return {
    endedAt: 0,
    promptCacheTtlMs: HOUR,
    contextTokens: 600_000,
    contextWindowTokens: 1_000_000,
    ...overrides,
  };
}

describe('promptCacheStanding', () => {
  it('is warm until the lifetime after the turn ended, expired from then on', () => {
    expect(promptCacheStanding(facts(), HOUR - 1)).toEqual({
      state: 'warm',
      expiresAt: HOUR,
    });
    expect(promptCacheStanding(facts(), HOUR)).toEqual({
      state: 'expired',
      expiredAt: HOUR,
    });
  });

  it('is unknown when the CLI stated no lifetime — never expired', () => {
    expect(
      promptCacheStanding(facts({ promptCacheTtlMs: null }), 10 * HOUR),
    ).toEqual({ state: 'unknown' });
    expect(promptCacheStanding(facts({ endedAt: null }), 10 * HOUR)).toEqual({
      state: 'unknown',
    });
  });
});

describe('isColdAndLarge', () => {
  it('holds for an expired cache over half its window', () => {
    expect(isColdAndLarge(facts(), 2 * HOUR)).toBe(true);
  });

  it('does not hold while the cache is warm, however full the window', () => {
    expect(isColdAndLarge(facts({ contextTokens: 990_000 }), HOUR / 2)).toBe(
      false,
    );
  });

  it('does not hold at or under half the window', () => {
    expect(isColdAndLarge(facts({ contextTokens: 500_000 }), 2 * HOUR)).toBe(
      false,
    );
  });

  it('does not hold when the window or the lifetime was never measured', () => {
    expect(isColdAndLarge(facts({ contextWindowTokens: null }), 2 * HOUR)).toBe(
      false,
    );
    expect(isColdAndLarge(facts({ promptCacheTtlMs: null }), 2 * HOUR)).toBe(
      false,
    );
  });
});

describe('conversationFacts', () => {
  it('takes timing and window from the newest call, the lifetime from the newest that stated one', () => {
    const merged = conversationFacts([
      facts({ endedAt: 1, promptCacheTtlMs: HOUR, contextTokens: 10 }),
      facts({ endedAt: 5, promptCacheTtlMs: null, contextTokens: 20 }),
    ]);
    expect(merged).toEqual(
      facts({ endedAt: 5, promptCacheTtlMs: HOUR, contextTokens: 20 }),
    );
  });

  it('answers all-unknown for a conversation with no settled call', () => {
    expect(conversationFacts([])).toEqual({
      endedAt: null,
      promptCacheTtlMs: null,
      contextTokens: null,
      contextWindowTokens: null,
    });
  });
});

describe('advanceCacheClock / cacheExpiryOf', () => {
  const usage = (promptCacheTtlMs?: number) => ({
    usage: promptCacheTtlMs === undefined ? {} : { promptCacheTtlMs },
  });

  it('moves the end to the newest turn and keeps the lifetime a cache-only turn did not state', () => {
    const first = advanceCacheClock(undefined, new Date(1_000), usage(HOUR));
    const second = advanceCacheClock(first, new Date(5_000), usage());
    expect(second).toEqual({ endedAt: 5_000, promptCacheTtlMs: HOUR });
    expect(cacheExpiryOf(second)).toBe(new Date(5_000 + HOUR).toISOString());
  });

  it('falls back to the lifetime the agent stated elsewhere when this conversation stated none', () => {
    const clock = advanceCacheClock(undefined, new Date(5_000), usage(), HOUR);
    expect(cacheExpiryOf(clock)).toBe(new Date(5_000 + HOUR).toISOString());
  });

  it('states no expiry when nothing stated a lifetime', () => {
    expect(
      cacheExpiryOf(advanceCacheClock(undefined, new Date(5_000), usage())),
    ).toBeNull();
    expect(cacheExpiryOf(undefined)).toBeNull();
  });
});

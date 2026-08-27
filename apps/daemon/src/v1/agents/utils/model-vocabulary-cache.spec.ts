import { describe, expect, it, vi } from 'vitest';

import { ModelVocabularyCache, volatile } from './model-vocabulary-cache';

describe('ModelVocabularyCache', () => {
  it('serves a VOLATILE answer without remembering it', async () => {
    // A listing that could not be obtained still has to answer with something,
    // but storing the stand-in turns one transient probe failure into a
    // TTL-long outage: the next request reads the fallback as a fresh answer
    // and never re-asks.
    let clock = 0;
    const cache = new ModelVocabularyCache<string>({
      ttlMs: 1000,
      now: () => clock,
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(volatile('stand-in'))
      .mockResolvedValueOnce('real-answer');

    const first = await cache.read('claude', 'opus', 'cli-1.0.0', fetch);
    clock = 1; // well inside the TTL
    const second = await cache.read('claude', 'opus', 'cli-1.0.0', fetch);

    // The caller still gets the stand-in — the picker is not left empty…
    expect(first).toBe('stand-in');
    // …and the very next request re-asks rather than serving it again.
    expect(second).toBe('real-answer');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('leaves the LAST GOOD answer in place when a later read is volatile', async () => {
    // The failure must not evict what was already known: `fresh()` is a
    // synchronous request-path read, and dropping the entry would make it
    // answer "nothing held" on the strength of one failed probe.
    let clock = 0;
    const cache = new ModelVocabularyCache<string>({
      ttlMs: 1000,
      now: () => clock,
    });

    await cache.read('claude', 'opus', 'cli-1.0.0', async () => 'good');
    clock = 1001; // past the TTL, so the next read re-fetches
    await cache.read('claude', 'opus', 'cli-1.0.0', async (previous) => {
      // The fallback the services build is `previous ?? <union>` — so the
      // previous value has to still be reachable here.
      expect(previous).toBe('good');
      return volatile(previous ?? 'union');
    });

    clock = 1002;
    expect(
      await cache.read('claude', 'opus', 'cli-1.0.0', async () => 'fresh'),
    ).toBe('fresh');
  });

  it('serves the cached value within the TTL when the version has not changed', async () => {
    let clock = 0;
    const cache = new ModelVocabularyCache<string>({
      ttlMs: 1000,
      now: () => clock,
    });
    const fetch = vi.fn().mockResolvedValue('v1-answer');

    const first = await cache.read('claude', 'opus', 'cli-1.0.0', fetch);
    clock = 999; // still inside the TTL
    const second = await cache.read('claude', 'opus', 'cli-1.0.0', fetch);

    expect(first).toBe('v1-answer');
    expect(second).toBe('v1-answer');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('re-fetches when the version changes, even well inside the TTL', async () => {
    // A CLI upgraded underneath a running daemon must not keep serving the old
    // vocabulary for the rest of the TTL — the whole reason this class exists.
    let clock = 0;
    const cache = new ModelVocabularyCache<string>({
      ttlMs: 1000,
      now: () => clock,
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce('v1-answer')
      .mockResolvedValueOnce('v2-answer');

    const first = await cache.read('claude', 'opus', 'cli-1.0.0', fetch);
    clock = 1;
    const second = await cache.read('claude', 'opus', 'cli-2.0.0', fetch);

    expect(first).toBe('v1-answer');
    expect(second).toBe('v2-answer');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('re-fetches once the TTL has elapsed, version unchanged', async () => {
    let clock = 0;
    const cache = new ModelVocabularyCache<string>({
      ttlMs: 1000,
      now: () => clock,
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('second');

    await cache.read('claude', 'opus', 'cli-1.0.0', fetch);
    clock = 1000; // >= ttlMs — stale
    const after = await cache.read('claude', 'opus', 'cli-1.0.0', fetch);

    expect(after).toBe('second');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('asks once when two callers race on the same (kind, model)', async () => {
    const cache = new ModelVocabularyCache<string>({
      ttlMs: 1000,
      now: () => 0,
    });
    let resolveFetch!: (value: string) => void;
    const fetch = vi.fn().mockReturnValue(
      new Promise<string>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const both = Promise.all([
      cache.read('claude', 'opus', 'cli-1.0.0', fetch),
      cache.read('claude', 'opus', 'cli-1.0.0', fetch),
    ]);
    resolveFetch('joined-answer');

    expect(await both).toEqual(['joined-answer', 'joined-answer']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keys a null model as its own entry, never the CLI-wide answer for a model', async () => {
    const cache = new ModelVocabularyCache<string>({
      ttlMs: 1000,
      now: () => 0,
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce('cli-wide')
      .mockResolvedValueOnce('per-model');

    const wide = await cache.read('claude', null, 'cli-1.0.0', fetch);
    const perModel = await cache.read('claude', 'opus', 'cli-1.0.0', fetch);

    expect(wide).toBe('cli-wide');
    expect(perModel).toBe('per-model');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('evicts the OLDEST entry once the cap is reached, keeping the newest', async () => {
    // Insertion-ordered `Map` iteration is what lets eviction find "the
    // oldest key" for free — this pins that the cap is actually enforced on
    // write, not merely documented. The cap itself (200) lives beside the
    // implementation; this loop reaches one past it without hardcoding that
    // number a second time.
    const cache = new ModelVocabularyCache<string>({
      ttlMs: 1000,
      now: () => 0,
    });
    const CAP = 200;
    for (let i = 0; i <= CAP; i++) {
      await cache.read(
        'claude',
        `model-${i}`,
        'cli-1.0.0',
        async () => `answer-${i}`,
      );
    }

    // The very first entry inserted was pushed out — a fresh read re-fetches
    // it instead of finding it still cached.
    const refetch = vi.fn().mockResolvedValue('re-fetched');
    expect(await cache.read('claude', 'model-0', 'cli-1.0.0', refetch)).toBe(
      're-fetched',
    );
    expect(refetch).toHaveBeenCalledTimes(1);

    // The newest entry survives — no fetch needed, the cached value answers.
    const shouldNotBeCalled = vi.fn();
    expect(
      await cache.read(
        'claude',
        `model-${CAP}`,
        'cli-1.0.0',
        shouldNotBeCalled,
      ),
    ).toBe(`answer-${CAP}`);
    expect(shouldNotBeCalled).not.toHaveBeenCalled();
  });

  it('does not count a VOLATILE answer toward the cap or evict anything', async () => {
    // A stand-in answer is served but never stored (see `volatile()`), so it
    // must not participate in the eviction accounting at all — filling the
    // cache with volatile answers should never push a real entry out.
    const cache = new ModelVocabularyCache<string>({
      ttlMs: 1000,
      now: () => 0,
    });
    await cache.read('claude', 'kept', 'cli-1.0.0', async () => 'kept-answer');

    const CAP = 200;
    for (let i = 0; i < CAP * 2; i++) {
      await cache.read('claude', `volatile-${i}`, 'cli-1.0.0', async () =>
        volatile(`stand-in-${i}`),
      );
    }

    const shouldNotBeCalled = vi.fn();
    expect(
      await cache.read('claude', 'kept', 'cli-1.0.0', shouldNotBeCalled),
    ).toBe('kept-answer');
    expect(shouldNotBeCalled).not.toHaveBeenCalled();
  });

  describe('clear', () => {
    it('drops a stored entry, so the next read asks again inside the TTL', async () => {
      // What the menu bar's Clear Agent Cache actually buys. Clearing only the
      // durable file would leave this daemon serving its memory for the rest of
      // the TTL — a user who presses a button and sees the same stale list for
      // ten minutes has been told the button does nothing.
      let clock = 0;
      const cache = new ModelVocabularyCache<string>({
        ttlMs: 10 * 60_000,
        now: () => clock,
      });
      const fetch = vi
        .fn()
        .mockResolvedValueOnce('first')
        .mockResolvedValueOnce('second');

      expect(await cache.read('claude', 'opus', 'cli-1.0.0', fetch)).toBe(
        'first',
      );
      clock = 1; // well inside the TTL, so only the clear can force a re-ask
      expect(cache.clear()).toBe(1);

      expect(await cache.read('claude', 'opus', 'cli-1.0.0', fetch)).toBe(
        'second',
      );
      expect(fetch).toHaveBeenCalledTimes(2);
      // …and the synchronous request-path read agrees, rather than answering
      // from an entry `read` has stopped serving.
      cache.clear();
      expect(cache.fresh('claude', 'opus')).toBeUndefined();
    });

    it('counts what it dropped, and answers zero for an empty cache', async () => {
      // The count is what `CacheResetService` sums into the number it logs, so
      // a clear that forgot to report would silently under-count the reset.
      const cache = new ModelVocabularyCache<string>({
        ttlMs: 1000,
        now: () => 0,
      });
      await cache.read('claude', 'opus', 'cli-1.0.0', async () => 'a');
      await cache.read('claude', 'sonnet', 'cli-1.0.0', async () => 'b');
      await cache.read('cursor-agent', null, 'cli-2.0.0', async () => 'c');

      expect(cache.clear()).toBe(3);
      expect(cache.clear()).toBe(0);
    });
  });

  describe('fresh', () => {
    it('answers synchronously from a fresh entry, never consulting the version', async () => {
      let clock = 0;
      const cache = new ModelVocabularyCache<string>({
        ttlMs: 1000,
        now: () => clock,
      });
      await cache.read('claude', 'opus', 'cli-1.0.0', async () => 'answer');
      clock = 999;

      expect(cache.fresh('claude', 'opus')).toBe('answer');
    });

    it('answers undefined once the TTL has elapsed', async () => {
      let clock = 0;
      const cache = new ModelVocabularyCache<string>({
        ttlMs: 1000,
        now: () => clock,
      });
      await cache.read('claude', 'opus', 'cli-1.0.0', async () => 'answer');
      clock = 1000;

      expect(cache.fresh('claude', 'opus')).toBeUndefined();
    });

    it('answers undefined for a key nothing has asked yet', () => {
      const cache = new ModelVocabularyCache<string>({
        ttlMs: 1000,
        now: () => 0,
      });

      expect(cache.fresh('claude', 'opus')).toBeUndefined();
    });
  });
});

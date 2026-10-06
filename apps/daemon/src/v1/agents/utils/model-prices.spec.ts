import { describe, expect, it } from 'vitest';

import {
  countModelPrices,
  lookupModelPrice,
  modelPriceCatalogShape,
  parseModelPriceCatalog,
  ratesForPrompt,
  tokenCostUsd,
} from './model-prices';

/**
 * Entries transcribed from `https://models.dev/api.json` as fetched on
 * 2026-10-05 — the real shape, with a few broken entries added beside them.
 */
const CATALOG = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    models: {
      'gpt-6-astra': {
        id: 'gpt-6-astra',
        cost: {
          input: 10,
          output: 50,
          cache_read: 1,
          cache_write: 12.5,
          tiers: [
            {
              input: 20,
              output: 75,
              cache_read: 2,
              cache_write: 25,
              tier: { type: 'context', size: 272_000 },
            },
          ],
          context_over_200k: {
            input: 20,
            output: 75,
            cache_read: 2,
            cache_write: 25,
          },
        },
      },
      'gpt-5.3-codex': {
        id: 'gpt-5.3-codex',
        cost: { input: 1.75, output: 14, cache_read: 0.175 },
      },
      'gpt-image-1': { id: 'gpt-image-1' },
      'placeholder-zero': { cost: { input: 0, output: 0 } },
      'broken-rate': { cost: { input: '10', output: 50 } },
      'negative-rate': { cost: { input: -1, output: 5 } },
    },
  },
  anthropic: {
    models: {
      'claude-opus-5': {
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      },
    },
  },
  // A provider no adapter prices under is not read at all.
  'some-gateway': {
    models: { 'gpt-6-astra': { cost: { input: 1, output: 1 } } },
  },
};

describe('parseModelPriceCatalog', () => {
  it('reads every usable price of the providers adapters price under', () => {
    const table = parseModelPriceCatalog(CATALOG);
    expect(lookupModelPrice(table, 'openai', 'gpt-6-astra')).toEqual({
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
      tiers: [
        {
          input: 20,
          output: 75,
          cacheRead: 2,
          cacheWrite: 25,
          aboveContextTokens: 272_000,
        },
      ],
    });
    expect(lookupModelPrice(table, 'anthropic', 'claude-opus-5')).toMatchObject(
      { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, tiers: [] },
    );
    expect(countModelPrices(table)).toBe(3);
  });

  it('keeps a cache rate the catalog omits as unknown, not as zero', () => {
    const price = lookupModelPrice(
      parseModelPriceCatalog(CATALOG),
      'openai',
      'gpt-5.3-codex',
    );
    expect(price?.cacheRead).toBe(0.175);
    expect(price?.cacheWrite).toBeNull();
  });

  it('refuses an entry with no cost, a zero placeholder, or an unusable rate', () => {
    const table = parseModelPriceCatalog(CATALOG);
    for (const id of [
      'gpt-image-1',
      'placeholder-zero',
      'broken-rate',
      'negative-rate',
    ]) {
      expect(lookupModelPrice(table, 'openai', id)).toBeNull();
    }
  });

  it('matches a model id EXACTLY — a CLI variant spelling is not a catalog id', () => {
    const table = parseModelPriceCatalog(CATALOG);
    expect(
      lookupModelPrice(table, 'anthropic', 'claude-opus-5[1m]'),
    ).toBeNull();
    expect(lookupModelPrice(table, 'anthropic', 'CLAUDE-OPUS-5')).toBeNull();
    // The same id under the wrong provider is not a price either.
    expect(lookupModelPrice(table, 'anthropic', 'gpt-6-astra')).toBeNull();
  });

  it('reads nothing out of a reply that is not the catalog', () => {
    expect(countModelPrices(parseModelPriceCatalog(null))).toBe(0);
    expect(countModelPrices(parseModelPriceCatalog('<html>'))).toBe(0);
    expect(countModelPrices(parseModelPriceCatalog({ openai: [] }))).toBe(0);
  });

  it('skips a tier that is not a context tier or has no usable size', () => {
    const table = parseModelPriceCatalog({
      openai: {
        models: {
          m: {
            cost: {
              input: 1,
              output: 2,
              tiers: [
                { input: 9, output: 9, tier: { type: 'volume', size: 10 } },
                { input: 9, output: 9, tier: { type: 'context', size: 0 } },
                { input: 3, output: 4, tier: { type: 'context', size: 500 } },
                { input: 2, output: 3, tier: { type: 'context', size: 100 } },
              ],
            },
          },
        },
      },
    });
    // The two usable tiers, ascending by threshold whatever order they came in.
    expect(
      lookupModelPrice(table, 'openai', 'm')?.tiers.map(
        (tier) => tier.aboveContextTokens,
      ),
    ).toEqual([100, 500]);
  });

  it('round-trips through the shape it is persisted in', () => {
    const table = parseModelPriceCatalog(CATALOG);
    const reread = parseModelPriceCatalog(
      JSON.parse(JSON.stringify(modelPriceCatalogShape(table))),
    );
    expect(reread).toEqual(table);
  });
});

describe('ratesForPrompt', () => {
  const price = lookupModelPrice(
    parseModelPriceCatalog(CATALOG),
    'openai',
    'gpt-6-astra',
  )!;

  it('bills a prompt past a tier’s size at that tier', () => {
    expect(ratesForPrompt(price, 272_001).input).toBe(20);
  });

  it('bills a prompt AT the size, or under it, at the base rates', () => {
    expect(ratesForPrompt(price, 272_000).input).toBe(10);
    expect(ratesForPrompt(price, 1_000).input).toBe(10);
  });

  it('bills an unmeasured prompt at the base rates', () => {
    expect(ratesForPrompt(price, null).input).toBe(10);
  });
});

describe('tokenCostUsd', () => {
  it('prices each kind of token at its own rate, per million', () => {
    const cost = tokenCostUsd(
      { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 2_000_000,
        cacheWriteTokens: 400_000,
      },
    );
    // 10 + 5 + 2 + 5
    expect(cost).toBeCloseTo(22, 10);
  });

  it('bills cache traffic at the INPUT rate when the catalog names no cache rate', () => {
    const cost = tokenCostUsd(
      { input: 2, output: 8, cacheRead: null, cacheWrite: null },
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      },
    );
    expect(cost).toBeCloseTo(4, 10);
  });

  it('counts an absent figure as zero rather than voiding the sum', () => {
    expect(
      tokenCostUsd(
        { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 },
        {
          inputTokens: null,
          outputTokens: 500_000,
          cacheReadTokens: null,
          cacheWriteTokens: null,
        },
      ),
    ).toBeCloseTo(4, 10);
  });
});

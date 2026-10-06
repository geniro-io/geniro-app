import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MODEL_PRICE_CATALOG_URL } from '../utils/model-prices';
import {
  MODEL_PRICES_FILE_NAME,
  MODEL_PRICES_REFRESH_AFTER_MS,
  ModelPriceCatalog,
  type ModelPriceFetch,
} from './model-price-catalog.service';

/** A models.dev reply, cut to what this daemon reads. */
function reply(astraInput: number): unknown {
  return {
    openai: {
      models: {
        'gpt-6-astra': {
          cost: {
            input: astraInput,
            output: 50,
            cache_read: 1,
            cache_write: 12.5,
          },
        },
      },
    },
    anthropic: {
      models: {
        'claude-opus-5': {
          cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        },
      },
    },
  };
}

function answering(body: unknown): {
  fetch: ModelPriceFetch;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetch: (url) => {
      calls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            typeof body === 'string' ? body : JSON.stringify(body),
          ),
      });
    },
  };
}

let dir: string;
let file: string;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'geniro-prices-'));
  file = join(dir, MODEL_PRICES_FILE_NAME);
  now = 1_000_000_000_000;
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function catalog(fetch: ModelPriceFetch | null): ModelPriceCatalog {
  return new ModelPriceCatalog({ file, now: () => now, fetch });
}

describe('ModelPriceCatalog', () => {
  it('fetches the one fixed URL, prices from it, and persists the copy', async () => {
    const network = answering(reply(10));
    const prices = catalog(network.fetch);

    expect(prices.priceOf('openai', 'gpt-6-astra')).toBeNull();
    await prices.refreshIfStale();

    expect(network.calls).toEqual([MODEL_PRICE_CATALOG_URL]);
    expect(prices.priceOf('openai', 'gpt-6-astra')?.input).toBe(10);
    // The persisted copy is the two providers this daemon reads, stamped.
    const stored = JSON.parse(readFileSync(file, 'utf8')) as {
      fetchedAt: number;
      catalog: Record<string, unknown>;
    };
    expect(stored.fetchedAt).toBe(now);
    expect(Object.keys(stored.catalog).sort()).toEqual(['anthropic', 'openai']);
  });

  it('prices OFFLINE from the stored copy a previous launch wrote', async () => {
    await catalog(answering(reply(10)).fetch).refreshIfStale();

    // A new launch with no network at all.
    const offline = catalog(null);
    offline.onModuleInit();

    expect(offline.priceOf('openai', 'gpt-6-astra')?.input).toBe(10);
    expect(offline.priceOf('anthropic', 'claude-opus-5')?.cacheWrite).toBe(
      6.25,
    );
    offline.onApplicationShutdown();
  });

  it('does not ask again while the held copy is fresh, and does once it is stale', async () => {
    await catalog(answering(reply(10)).fetch).refreshIfStale();

    const network = answering(reply(11));
    const relaunch = catalog(network.fetch);
    now += MODEL_PRICES_REFRESH_AFTER_MS - 1;
    await relaunch.refreshIfStale();
    expect(network.calls).toHaveLength(0);
    expect(relaunch.priceOf('openai', 'gpt-6-astra')?.input).toBe(10);

    now += 1;
    await relaunch.refreshIfStale();
    expect(network.calls).toHaveLength(1);
    expect(relaunch.priceOf('openai', 'gpt-6-astra')?.input).toBe(11);
  });

  it('reads a stamp from the future as stale rather than as fresh', async () => {
    await catalog(answering(reply(10)).fetch).refreshIfStale();
    now -= 60_000;

    const network = answering(reply(11));
    await catalog(network.fetch).refreshIfStale();

    expect(network.calls).toHaveLength(1);
  });

  it('asks once for concurrent refreshes', async () => {
    const network = answering(reply(10));
    const prices = catalog(network.fetch);

    await Promise.all([prices.refreshIfStale(), prices.refreshIfStale()]);

    expect(network.calls).toHaveLength(1);
  });

  it.each([
    [
      'the network fails',
      (): Promise<never> => Promise.reject(new Error('ENOTFOUND models.dev')),
    ],
    [
      'the host answers an error status',
      () =>
        Promise.resolve({
          ok: false,
          status: 503,
          text: () => Promise.resolve('down'),
        }),
    ],
    ['the reply is not JSON', answering('<html>outage</html>').fetch],
    [
      'the reply prices nothing this daemon reads',
      answering({ openai: { models: {} } }).fetch,
    ],
  ])(
    'keeps the last good copy, and says so, when %s',
    async (_case, failing) => {
      await catalog(answering(reply(10)).fetch).refreshIfStale();
      now += MODEL_PRICES_REFRESH_AFTER_MS;
      const before = readFileSync(file, 'utf8');

      const prices = catalog(failing as ModelPriceFetch);
      await expect(prices.refreshIfStale()).resolves.toBeUndefined();

      expect(prices.priceOf('openai', 'gpt-6-astra')?.input).toBe(10);
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining('keeping the last good copy'),
      );
    },
  );

  it('reads a corrupt stored file as nothing priced, and a good fetch repairs it', async () => {
    writeFileSync(file, '{"fetchedAt": 1, "catalog": ');
    const network = answering(reply(10));
    const prices = catalog(network.fetch);

    expect(prices.priceOf('openai', 'gpt-6-astra')).toBeNull();
    await prices.refreshIfStale();

    expect(network.calls).toHaveLength(1);
    expect(catalog(null).priceOf('openai', 'gpt-6-astra')?.input).toBe(10);
  });

  it('never reaches the network in the test environment, whose switch is off', async () => {
    // No `fetch` seam at all: the default is decided by the environment, and
    // the test environment's `fetchModelPrices` is false — which is what keeps
    // a booted test container off models.dev.
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('a spec reached the network'));
    const prices = new ModelPriceCatalog({ file, now: () => now });
    prices.onModuleInit();
    await prices.refreshIfStale();

    expect(network).not.toHaveBeenCalled();
    expect(prices.priceOf('openai', 'gpt-6-astra')).toBeNull();
    prices.onApplicationShutdown();
  });

  it('refreshes behind the boot, without the boot waiting on it', async () => {
    const gate: { release?: () => void } = {};
    const prices = catalog(
      () =>
        new Promise((resolve) => {
          gate.release = () =>
            resolve({
              ok: true,
              status: 200,
              text: () => Promise.resolve(JSON.stringify(reply(10))),
            });
        }),
    );

    // Returns at once with the fetch still out — and returns NOTHING, so Nest
    // has no promise to hold the boot on (an `async` hook would hand it one).
    expect(prices.onModuleInit()).toBeUndefined();
    expect(prices.priceOf('openai', 'gpt-6-astra')).toBeNull();

    gate.release?.();
    await prices.refreshIfStale();
    expect(prices.priceOf('openai', 'gpt-6-astra')?.input).toBe(10);
    prices.onApplicationShutdown();
  });
});

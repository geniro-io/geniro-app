import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import {
  lookupModelPrice,
  type ModelPriceProvider,
  parseModelPriceCatalog,
} from '../utils/model-prices';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import { ModelPriceService } from './model-price.service';

const profileDir = mkdtempSync(join(tmpdir(), 'geniro-price-profile-'));
afterAll(() => rmSync(profileDir, { recursive: true, force: true }));

const table = parseModelPriceCatalog({
  anthropic: {
    models: {
      'claude-opus-5-5': {
        cost: { input: 4, output: 20, cache_read: 0.4 },
        limit: { context: 1_000_000 },
      },
    },
  },
});

class AliasingClaude extends ClaudeAdapter {
  resolvedFrom: string[] = [];

  override resolveModel(
    model: string | null,
    configDir: string | null,
  ): Promise<string | null> {
    this.resolvedFrom.push(`${String(model)}@${String(configDir)}`);
    if (model === 'broken') {
      return Promise.reject(new Error('probe failed'));
    }
    return Promise.resolve(model === 'opus' ? 'claude-opus-5-5' : model);
  }
}

function priceService(): { prices: ModelPriceService; claude: AliasingClaude } {
  const claude = new AliasingClaude({
    prices: {
      priceOf: (provider: ModelPriceProvider, model: string) =>
        lookupModelPrice(table, provider, model),
    },
  });
  return {
    claude,
    prices: new ModelPriceService({
      for: () => claude,
    } as unknown as AgentAdapterRegistry),
  };
}

describe('ModelPriceService.answer', () => {
  it('answers a listed id at its list price without resolving it, the window left off the wire', async () => {
    const { prices, claude } = priceService();

    await expect(
      prices.answer('claude', 'claude-opus-5-5[1m]', null),
    ).resolves.toEqual({
      pricedAs: 'claude-opus-5-5[1m]',
      price: {
        input: 4,
        output: 20,
        cacheRead: 0.4,
        cacheWrite: null,
        tiers: [],
      },
    });
    expect(claude.resolvedFrom).toEqual([]);
  });

  it('prices an alias as the model it runs as', async () => {
    const { prices, claude } = priceService();

    const answer = await prices.answer('claude', 'opus', profileDir);

    expect(answer.pricedAs).toBe('claude-opus-5-5');
    expect(answer.price?.output).toBe(20);
    expect(claude.resolvedFrom).toEqual([`opus@${realpathSync(profileDir)}`]);
  });

  it('never resolves a model of no catalog vendor, so no probe starts for it', async () => {
    const { prices, claude } = priceService();

    await expect(
      prices.answer('claude', 'ollama/qwen3', null),
    ).resolves.toEqual({ pricedAs: null, price: null });
    expect(claude.resolvedFrom).toEqual([]);
  });

  it('refuses an account directory that does not exist', async () => {
    const { prices, claude } = priceService();

    await expect(
      prices.answer('claude', 'opus', join(profileDir, 'missing')),
    ).rejects.toMatchObject({ errorCode: 'INVALID_CONFIG_DIR' });
    expect(claude.resolvedFrom).toEqual([]);
  });

  it('answers no price for an unlisted model, and for one whose resolution failed', async () => {
    const { prices } = priceService();

    await expect(
      prices.answer('claude', 'claude-unknown-9', null),
    ).resolves.toEqual({
      pricedAs: null,
      price: null,
    });
    await expect(prices.answer('claude', 'broken', null)).resolves.toEqual({
      pricedAs: null,
      price: null,
    });
  });
});

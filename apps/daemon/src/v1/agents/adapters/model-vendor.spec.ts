import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  lookupModelPrice,
  type ModelPriceProvider,
  parseModelPriceCatalog,
} from '../utils/model-prices';
import { freshVocabularyStore } from './__tests__/fresh-vocabulary-store';
import type { AdapterDaemonDeps } from './adapter.types';
import { ClaudeAdapter } from './claude/claude.adapter';
import { CodexAdapter } from './codex/codex.adapter';
import { CursorAcpAdapter } from './cursor-acp/cursor-acp.adapter';

describe('AgentAdapter.modelVendorOf', () => {
  it('names one vendor for every model of a single-vendor CLI, and none for a local model', () => {
    const claude = new ClaudeAdapter();
    const codex = new CodexAdapter();

    expect(claude.modelVendorOf('opus')).toBe('anthropic');
    expect(claude.modelVendorOf(null)).toBe('anthropic');
    expect(claude.modelVendorOf('ollama/qwen3')).toBeNull();
    expect(codex.modelVendorOf('gpt-6.1-sol')).toBe('openai');
  });

  it("reads a multi-vendor CLI's vendor off the model id, and none for an auto pick", () => {
    const cursor = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
    });

    expect(cursor.modelVendorOf('claude-opus-5-5-high')).toBe('anthropic');
    expect(cursor.modelVendorOf('GPT-5.6-sol-high')).toBe('openai');
    expect(cursor.modelVendorOf('gemini-3.7-flash-high')).toBe('google');
    expect(cursor.modelVendorOf('cursor-grok-4.6-high')).toBe('xai');
    expect(cursor.modelVendorOf('kimi-k3')).toBe('moonshotai');
    expect(cursor.modelVendorOf('glm-5.2')).toBe('zai');
    expect(cursor.modelVendorOf('composer-2.5')).toBe('cursor');
    expect(cursor.modelVendorOf('auto')).toBeNull();
    expect(cursor.modelVendorOf(null)).toBeNull();
  });
});

describe('AgentAdapter.modelPriceOf', () => {
  const prices = {
    priceOf: (provider: ModelPriceProvider, model: string) =>
      lookupModelPrice(
        parseModelPriceCatalog({
          anthropic: {
            models: {
              'claude-opus-5': { cost: { input: 5, output: 25 } },
              'claude-haiku-5-5': { cost: { input: 0.1, output: 0.5 } },
            },
          },
          openai: {
            models: { 'gpt-6.1-sol': { cost: { input: 2, output: 10 } } },
          },
          xai: { models: { 'grok-4.7': { cost: { input: 2, output: 6 } } } },
          moonshotai: {
            models: { 'kimi-k3': { cost: { input: 3, output: 15 } } },
          },
          zai: {
            models: {
              'glm-5.2': { cost: { input: 1, output: 3.2 } },
              'glm-5.3': { cost: { input: 1.2, output: 4 } },
            },
          },
          google: {
            models: {
              'gemini-3.1-pro-preview': { cost: { input: 2, output: 12 } },
            },
          },
        }),
        provider,
        model,
      ),
  };

  it("shows a single-vendor CLI's model at its vendor's list price, its variant spelling included", () => {
    const claude = new ClaudeAdapter({ prices });
    const codex = new CodexAdapter({ prices });

    expect(claude.modelPriceOf('claude-opus-5')?.output).toBe(25);
    expect(claude.modelPriceOf('claude-opus-5[1m]')?.input).toBe(5);
    expect(codex.modelPriceOf('gpt-6.1-sol')?.input).toBe(2);
    expect(claude.modelPriceOf('opus')).toBeNull();
    expect(claude.modelPriceOf('ollama/qwen3')).toBeNull();
    expect(claude.modelPriceOf(null)).toBeNull();
  });

  it("shows cursor's models at their vendor's list price although its turns are never priced from it", () => {
    const cursor = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      prices,
    });

    expect(cursor.getConfig().usage.listPrice.kind).toBe('unavailable');
    expect(cursor.billingRatesOf('grok-4.7')).toBeNull();
    expect(cursor.modelPriceOf('grok-4.7-xhigh')?.output).toBe(6);
    expect(cursor.modelPriceOf('grok-4.7-high (Auto Balanced)')?.input).toBe(2);
    expect(cursor.modelPriceOf('claude-haiku-5-5-thinking-high')?.input).toBe(
      0.1,
    );
    expect(cursor.modelPriceOf('kimi-k3')?.output).toBe(15);
    expect(cursor.modelPriceOf('glm-5.2')?.output).toBe(3.2);
    expect(cursor.modelPriceOf('glm-5p3')?.output).toBe(4);
    expect(cursor.modelPriceOf('glm-5p3-high')?.input).toBe(1.2);
    expect(cursor.modelPriceOf('gemini-3.1-pro')?.output).toBe(12);
    expect(cursor.modelPriceOf('glm-9p9')).toBeNull();
    for (const variant of [
      'grok-4.7-minimal',
      'grok-4.7-low',
      'grok-4.7-medium',
      'grok-4.7-thinking',
      'grok-4.7[thinking=true,context=300k]',
    ]) {
      expect(cursor.modelPriceOf(variant)?.input).toBe(2);
    }
    expect(cursor.modelPriceOf('grok-4.7-xhigh-fast')).toBeNull();
    expect(cursor.modelPriceOf('composer-2.5')).toBeNull();
    expect(cursor.modelPriceOf('auto')).toBeNull();
  });

  it('prices nothing without a catalog', () => {
    expect(new ClaudeAdapter().modelPriceOf('claude-opus-5')).toBeNull();
  });

  it('is handed the catalog by every adapter the daemon builds', () => {
    const deps = {
      userDataDir: join(tmpdir(), 'geniro-model-vendor-spec'),
      spawn: () => {
        throw new Error('nothing here spawns');
      },
      logger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
      vocabularyStore: freshVocabularyStore(),
      versions: {},
      processes: {},
      clientVersion: '0.0.0',
      prices,
      hostToolResults: {},
    } as unknown as AdapterDaemonDeps;

    expect(
      ClaudeAdapter.forDaemon(deps).modelPriceOf('claude-opus-5')?.output,
    ).toBe(25);
    expect(
      CodexAdapter.forDaemon(deps).modelPriceOf('gpt-6.1-sol')?.input,
    ).toBe(2);
    expect(
      CursorAcpAdapter.forDaemon(deps).modelPriceOf('grok-4.7-high')?.output,
    ).toBe(6);
  });
});

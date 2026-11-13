import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it, vi } from 'vitest';

import type { ItemDao } from '../../agents/dao/item.dao';
import type { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import type { ModelPriceRates } from '../../agents/utils/model-prices';
import type { MemoryService } from '../../memory/services/memory.service';
import type { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import { DEFAULT_LESSONS_CONFIG, type LessonsConfig } from '../lessons.types';
import { LessonEstimateService } from './lesson-estimate.service';
import { LessonsConfigService } from './lessons-config.service';

/** A guide of a known length, so the literals below are worked out by hand. */
vi.mock('../utils/lessons-reflection-guide', () => ({
  lessonsReflectionGuide: (memoryEnabled: boolean) =>
    'g'.repeat(memoryEnabled ? 396 : 96),
}));

const RATES: ModelPriceRates = {
  input: 3,
  output: 15,
  cacheRead: null,
  cacheWrite: null,
};

const SOURCE = {
  id: 'src',
  agentKind: AgentKind.Claude,
  configDir: null,
} as Pick<Run, 'id' | 'agentKind' | 'configDir'>;

function build(
  options: {
    config?: Partial<LessonsConfig>;
    payloadChars?: number;
    rates?: ModelPriceRates | null;
    resolveModel?: (model: string | null) => Promise<string | null>;
    memoryEnabled?: boolean;
  } = {},
) {
  const itemDao = {
    payloadCharsBetween: vi.fn(() =>
      Promise.resolve(options.payloadChars ?? 4_000),
    ),
  };
  const adapter = {
    resolveModel: vi.fn(
      options.resolveModel ??
        ((model: string | null) => Promise.resolve(model)),
    ),
    billingRatesOf: vi.fn(() =>
      options.rates === undefined ? RATES : options.rates,
    ),
  };
  const adapters = { for: vi.fn(() => adapter) };
  const config = new LessonsConfigService();
  config.set({ ...DEFAULT_LESSONS_CONFIG, ...options.config });
  const em = { fork: () => em } as unknown as EntityManager;
  const service = new LessonEstimateService(
    em,
    itemDao as unknown as ItemDao,
    adapters as unknown as AgentAdapterRegistry,
    { enabled: options.memoryEnabled ?? true } as MemoryService,
    config,
  );
  return { service, itemDao, adapter, adapters };
}

describe('LessonEstimateService', () => {
  it('counts the stretch and the guide in characters, plus the read overhead and the answer', async () => {
    const h = build({ payloadChars: 4_001 });

    const estimate = await h.service.estimate(SOURCE, { fromSeq: 3, toSeq: 9 });

    expect(h.itemDao.payloadCharsBetween).toHaveBeenCalledWith(
      'src',
      3,
      9,
      expect.anything(),
    );
    // (4 001 + 396) chars / 4 → 1 100 (rounded up); + 8 000 read overhead + 2 000 answer.
    expect(estimate.tokens).toBe(11_100);
  });

  it('leaves the guide out of the count when the memory is off', async () => {
    const h = build({ payloadChars: 4_000, memoryEnabled: false });

    const estimate = await h.service.estimate(SOURCE, { fromSeq: 0, toSeq: 5 });

    // (4 000 + 96) chars / 4 = 1 024; + 8 000 read overhead + 2 000 answer.
    expect(estimate.tokens).toBe(11_024);
  });

  it('prices the input and the answer at the list price of the model', async () => {
    const h = build({ payloadChars: 4_000 });

    const estimate = await h.service.estimate(SOURCE, { fromSeq: 0, toSeq: 5 });

    // 9 099 input tokens at $3/M + 2 000 output tokens at $15/M = $0.057297.
    expect(h.adapter.billingRatesOf).toHaveBeenCalledWith(estimate.model);
    expect(estimate.usd).toBeCloseTo(0.057297, 10);
  });

  it('answers a null price when the model has no list price, never 0', async () => {
    const h = build({ rates: null });

    const estimate = await h.service.estimate(SOURCE, { fromSeq: 0, toSeq: 5 });

    expect(estimate.usd).toBeNull();
    expect(estimate.tokens).toBeGreaterThan(0);
  });

  it('shows the model the adapter resolves the choice to', async () => {
    const h = build({
      resolveModel: (model) =>
        Promise.resolve(model === 'haiku' ? 'claude-haiku-5-5' : model),
    });

    const estimate = await h.service.estimate(
      SOURCE,
      { fromSeq: 0, toSeq: 5 },
      {
        model: 'haiku',
      },
    );

    expect(h.adapter.resolveModel).toHaveBeenCalledWith('haiku', null);
    expect(estimate.model).toBe('claude-haiku-5-5');
  });

  it('shows the chosen model when the adapter cannot resolve it', async () => {
    const h = build({
      resolveModel: () => Promise.reject(new Error('no catalog')),
    });

    const estimate = await h.service.estimate(
      SOURCE,
      { fromSeq: 0, toSeq: 5 },
      {
        model: 'haiku',
      },
    );

    expect(estimate.model).toBe('haiku');
  });

  it('a press naming an agent and a model beats the settings', async () => {
    const h = build({
      config: { agentKind: AgentKind.Codex, model: 'gpt-settings' },
    });

    const estimate = await h.service.estimate(
      SOURCE,
      { fromSeq: 0, toSeq: 5 },
      {
        agentKind: AgentKind.Claude,
        model: 'haiku',
      },
    );

    expect(h.adapters.for).toHaveBeenCalledWith(AgentKind.Claude);
    expect(estimate.agentKind).toBe(AgentKind.Claude);
    expect(h.adapter.resolveModel).toHaveBeenCalledWith('haiku', null);
  });

  it('a settings model is dropped when the press names another agent', async () => {
    const h = build({
      config: { agentKind: AgentKind.Codex, model: 'gpt-settings' },
    });

    await h.service.estimate(
      SOURCE,
      { fromSeq: 0, toSeq: 5 },
      {
        agentKind: AgentKind.Claude,
      },
    );

    expect(h.adapter.resolveModel).toHaveBeenCalledWith(null, null);
  });

  it('a settings model is used when the press names no agent of its own', async () => {
    const h = build({
      config: { agentKind: AgentKind.Codex, model: 'gpt-settings' },
    });

    const estimate = await h.service.estimate(SOURCE, { fromSeq: 0, toSeq: 5 });

    expect(h.adapters.for).toHaveBeenCalledWith(AgentKind.Codex);
    expect(h.adapter.resolveModel).toHaveBeenCalledWith('gpt-settings', null);
    expect(estimate.agentKind).toBe(AgentKind.Codex);
  });
});

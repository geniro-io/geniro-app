import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { AgentAdapter } from '../adapters/agent-adapter';
import type { ModelPrice } from '../utils/model-prices';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentVocabularyService } from './agent-vocabulary.service';
import type { ContextWindowsService } from './context-windows.service';
import type { EffortsService } from './efforts.service';
import type { ModelParametersService } from './model-parameters.service';
import { ModelPriceService } from './model-price.service';
import type { ModelsService } from './models.service';

const profileDir = realpathSync(
  mkdtempSync(join(tmpdir(), 'geniro-vocabulary-profile-')),
);
afterAll(() => rmSync(profileDir, { recursive: true, force: true }));

const OPUS_PRICE: ModelPrice = {
  input: 4,
  output: 20,
  cacheRead: 0.4,
  cacheWrite: null,
  tiers: [],
  contextTokens: 1_000_000,
};

const priceService = new ModelPriceService({
  for: () =>
    ({
      modelPriceOf: (model: string | null) =>
        model === 'claude-opus-5-5' ? OPUS_PRICE : null,
    }) as unknown as AgentAdapter,
} as unknown as AgentAdapterRegistry);

function service(overrides: {
  models?: ModelsService['list'];
  efforts?: EffortsService['list'];
  contextWindows?: ContextWindowsService['listWire'];
  modelParameters?: ModelParametersService['listWire'];
}) {
  const models = {
    list: vi.fn(
      overrides.models ??
        (async () => [{ id: 'opus', label: 'Opus', source: 'cli' as const }]),
    ),
  };
  const efforts = {
    list: vi.fn(
      overrides.efforts ??
        (async () => ({
          efforts: [{ id: 'high', label: 'High' }],
          unavailableReason: null,
        })),
    ),
  };
  const contextWindows = {
    listWire: vi.fn(
      overrides.contextWindows ??
        (async () => ({
          windows: [],
          unavailableReason: 'no windows',
          unavailableKind: null,
        })),
    ),
  };
  const modelParameters = {
    listWire: vi.fn(
      overrides.modelParameters ??
        (async () => ({ parameters: [], unavailableReason: 'none' })),
    ),
  };
  return {
    models,
    efforts,
    contextWindows,
    modelParameters,
    vocabulary: new AgentVocabularyService(
      models as unknown as ModelsService,
      efforts as unknown as EffortsService,
      contextWindows as unknown as ContextWindowsService,
      modelParameters as unknown as ModelParametersService,
      priceService,
    ),
  };
}

describe('AgentVocabularyService', () => {
  it('asks each part of the service that owns it, with the same question', async () => {
    const s = service({});

    const answer = await s.vocabulary.read('claude', 'opus', profileDir);

    expect(s.models.list).toHaveBeenCalledWith('claude', profileDir);
    expect(s.efforts.list).toHaveBeenCalledWith('claude', 'opus', profileDir);
    expect(s.contextWindows.listWire).toHaveBeenCalledWith(
      'claude',
      'opus',
      profileDir,
    );
    expect(s.modelParameters.listWire).toHaveBeenCalledWith(
      'claude',
      'opus',
      profileDir,
    );
    expect(answer).toEqual({
      models: [{ id: 'opus', label: 'Opus', source: 'cli', price: null }],
      efforts: {
        efforts: [{ id: 'high', label: 'High' }],
        unavailableReason: null,
      },
      contextWindows: {
        windows: [],
        unavailableReason: 'no windows',
        unavailableKind: null,
      },
      modelParameters: { parameters: [], unavailableReason: 'none' },
    });
  });

  it('answers null for the one part that failed, and the other three as read', async () => {
    // A failed probe of one axis must not blank the picker's other three —
    // and null, not an empty listing, is what tells the client to ask again.
    const s = service({
      efforts: async () => {
        throw new Error('handshake timed out');
      },
    });

    const answer = await s.vocabulary.read('cursor-agent', 'grok', null);

    expect(answer.efforts).toBeNull();
    expect(answer.models).toEqual([
      { id: 'opus', label: 'Opus', source: 'cli', price: null },
    ]);
    expect(answer.contextWindows?.unavailableReason).toBe('no windows');
    expect(answer.modelParameters?.unavailableReason).toBe('none');
  });

  it('prices each model row at read time, an alias by the model it runs as', async () => {
    const s = service({
      models: async () => [
        {
          id: 'opus',
          label: 'Opus',
          source: 'cli' as const,
          resolvedModel: 'claude-opus-5-5',
        },
        { id: 'claude-opus-5-5', label: 'Opus 5.5', source: 'cli' as const },
        { id: 'ollama/qwen3', label: 'qwen3', source: 'ollama' as const },
      ],
    });

    const answer = await s.vocabulary.read('claude', null, null);

    expect(answer.models?.map((row) => row.price)).toEqual([
      { input: 4, output: 20, cacheRead: 0.4, cacheWrite: null, tiers: [] },
      { input: 4, output: 20, cacheRead: 0.4, cacheWrite: null, tiers: [] },
      null,
    ]);
  });

  it('throws the first reason when no part could be read at all', async () => {
    const fail = (message: string) => async () => {
      throw new Error(message);
    };
    const s = service({
      models: fail('config directory does not exist'),
      efforts: fail('second'),
      contextWindows: fail('third'),
      modelParameters: fail('fourth'),
    });

    await expect(s.vocabulary.read('claude', null, profileDir)).rejects.toThrow(
      'config directory does not exist',
    );
  });

  it('refuses an account folder that does not exist before any part asks a CLI under it', async () => {
    const s = service({});

    await expect(
      s.vocabulary.read('claude', null, join(profileDir, 'gone')),
    ).rejects.toMatchObject({ errorCode: 'INVALID_CONFIG_DIR' });
    expect(s.models.list).not.toHaveBeenCalled();
    expect(s.efforts.list).not.toHaveBeenCalled();
    expect(s.contextWindows.listWire).not.toHaveBeenCalled();
    expect(s.modelParameters.listWire).not.toHaveBeenCalled();
  });
});

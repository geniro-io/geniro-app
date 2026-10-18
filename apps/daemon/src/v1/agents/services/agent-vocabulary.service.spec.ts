import { describe, expect, it, vi } from 'vitest';

import { AgentVocabularyService } from './agent-vocabulary.service';
import type { ContextWindowsService } from './context-windows.service';
import type { EffortsService } from './efforts.service';
import type { ModelParametersService } from './model-parameters.service';
import type { ModelsService } from './models.service';

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
    ),
  };
}

describe('AgentVocabularyService', () => {
  it('asks each part of the service that owns it, with the same question', async () => {
    const s = service({});

    const answer = await s.vocabulary.read('claude', 'opus', '/profiles/work');

    expect(s.models.list).toHaveBeenCalledWith('claude', '/profiles/work');
    expect(s.efforts.list).toHaveBeenCalledWith(
      'claude',
      'opus',
      '/profiles/work',
    );
    expect(s.contextWindows.listWire).toHaveBeenCalledWith(
      'claude',
      'opus',
      '/profiles/work',
    );
    expect(s.modelParameters.listWire).toHaveBeenCalledWith(
      'claude',
      'opus',
      '/profiles/work',
    );
    expect(answer).toEqual({
      models: [{ id: 'opus', label: 'Opus', source: 'cli' }],
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
      { id: 'opus', label: 'Opus', source: 'cli' },
    ]);
    expect(answer.contextWindows?.unavailableReason).toBe('no windows');
    expect(answer.modelParameters?.unavailableReason).toBe('none');
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

    await expect(s.vocabulary.read('claude', null, '/nope')).rejects.toThrow(
      'config directory does not exist',
    );
  });
});

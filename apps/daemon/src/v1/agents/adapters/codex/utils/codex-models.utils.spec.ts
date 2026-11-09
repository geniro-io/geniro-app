import { describe, expect, it } from 'vitest';

import { readCodexModels } from './codex-models.utils';

/** Two rows transcribed from a live `model/list` (codex 0.157.1, a Plus account). */
const RESULT = {
  data: [
    {
      id: 'gpt-6-astra',
      model: 'gpt-6-astra',
      displayName: 'GPT-6-Astra',
      hidden: false,
      isDefault: true,
      serviceTiers: [
        {
          id: 'priority',
          name: 'Fast',
          description: '2x speed, increased usage',
        },
        { name: 'no id, so not a tier' },
      ],
      defaultServiceTier: null,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'fast' },
        { reasoningEffort: 'ultra', description: 'slowest' },
      ],
      defaultReasoningEffort: 'low',
    },
    {
      id: 'gpt-5.5',
      model: 'gpt-5.5',
      displayName: 'GPT-5.5',
      hidden: false,
      isDefault: false,
      defaultServiceTier: 'priority',
      supportedReasoningEfforts: [
        { reasoningEffort: 'medium', description: '' },
      ],
      defaultReasoningEffort: 'medium',
    },
    { id: 'internal-eval', displayName: 'Hidden', hidden: true },
  ],
  nextCursor: null,
};

describe('readCodexModels', () => {
  it('reads each model with its own efforts, in the CLI’s order', () => {
    expect(readCodexModels(RESULT)).toEqual([
      {
        id: 'gpt-6-astra',
        label: 'GPT-6-Astra',
        efforts: [
          { id: 'low', label: 'low' },
          { id: 'ultra', label: 'ultra' },
        ],
        isDefault: true,
        serviceTiers: [
          {
            id: 'priority',
            name: 'Fast',
            description: '2x speed, increased usage',
          },
        ],
        defaultServiceTier: null,
      },
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        efforts: [{ id: 'medium', label: 'medium' }],
        isDefault: false,
        serviceTiers: [],
        defaultServiceTier: 'priority',
      },
    ]);
  });

  it('answers [] for a result that is not a listing', () => {
    expect(readCodexModels(null)).toEqual([]);
    expect(readCodexModels({ data: 'x' })).toEqual([]);
  });
});

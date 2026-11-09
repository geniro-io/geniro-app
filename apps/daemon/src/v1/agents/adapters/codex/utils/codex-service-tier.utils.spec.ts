import { describe, expect, it } from 'vitest';

import type { ModelPrice } from '../../../utils/model-prices';
import type { CodexModelEntry } from './codex-models.utils';
import {
  codexModelParameterListing,
  codexServiceTierArgs,
  codexServiceTierOf,
  priceAtServiceTier,
} from './codex-service-tier.utils';

const FAST = {
  id: 'priority',
  name: 'Fast',
  description: '2x speed, increased usage',
};

function model(over: Partial<CodexModelEntry> = {}): CodexModelEntry {
  return {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1-Sol',
    efforts: [],
    isDefault: false,
    serviceTiers: [FAST],
    defaultServiceTier: null,
    ...over,
  };
}

describe('codexModelParameterListing', () => {
  it('offers one tier as a switch, in the CLI’s own words', () => {
    expect(codexModelParameterListing('gpt-6.1-sol', [model()])).toEqual({
      parameters: [
        {
          id: 'service_tier',
          label: 'Fast mode',
          values: [
            { id: 'default', label: 'Off' },
            {
              id: 'priority',
              label: 'On',
              description: '2x speed, increased usage',
            },
          ],
          current: null,
        },
      ],
      unavailableReason: null,
      exact: true,
    });
  });

  it('names each tier once a model offers several', () => {
    const listing = codexModelParameterListing('gpt-6.1-sol', [
      model({
        serviceTiers: [
          FAST,
          { id: 'ultrafast', name: 'Ultrafast', description: null },
        ],
      }),
    ]);

    expect(listing.parameters[0]?.values).toEqual([
      { id: 'default', label: 'Off' },
      {
        id: 'priority',
        label: 'Fast',
        description: '2x speed, increased usage',
      },
      { id: 'ultrafast', label: 'Ultrafast' },
    ]);
  });

  it('says what the catalog runs a model on by default', () => {
    const listing = codexModelParameterListing('gpt-6.1-sol', [
      model({ defaultServiceTier: 'priority' }),
    ]);

    expect(listing.parameters[0]?.current).toBe('priority');
  });

  it('offers nothing for a model with no tier, as that model’s own answer', () => {
    expect(
      codexModelParameterListing('gpt-6.1-sol', [model({ serviceTiers: [] })]),
    ).toMatchObject({ parameters: [], exact: true });
  });

  it('answers for the model codex marks as its default when none is named', () => {
    const listing = codexModelParameterListing(null, [
      model({ id: 'other', serviceTiers: [] }),
      model({ isDefault: true }),
    ]);
    expect(listing.parameters[0]?.id).toBe('service_tier');
    expect(listing.exact).toBe(false);

    expect(
      codexModelParameterListing(null, [model({ isDefault: false })]),
    ).toMatchObject({ parameters: [], exact: false });
  });

  it('tells a failed ask and an unlisted model from a model with no tier', () => {
    expect(codexModelParameterListing('gpt-6.1-sol', [])).toMatchObject({
      parameters: [],
      unavailableReason:
        'codex could not be asked which settings gpt-6.1-sol offers',
      exact: false,
    });
    expect(codexModelParameterListing('other', [model()])).toMatchObject({
      parameters: [],
      exact: false,
    });
  });
});

describe('the tier a turn asks for', () => {
  it('reads it from the turn’s parameters and nothing else', () => {
    expect(codexServiceTierOf({ service_tier: ' priority ' })).toBe('priority');
    expect(codexServiceTierOf({ service_tier: ' ' })).toBeNull();
    expect(codexServiceTierOf({ fastMode: 'true' })).toBeNull();
    expect(codexServiceTierOf(null)).toBeNull();
  });

  it('writes it as a quoted config override only when one is chosen', () => {
    expect(codexServiceTierArgs({ service_tier: 'priority' })).toEqual([
      '-c',
      'service_tier="priority"',
    ]);
    expect(codexServiceTierArgs({})).toEqual([]);
  });
});

describe('priceAtServiceTier', () => {
  const PRICE: ModelPrice = {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: null,
    tiers: [
      {
        input: 4,
        output: 15,
        cacheRead: 0.2,
        cacheWrite: 5,
        aboveContextTokens: 272_000,
      },
    ],
    contextTokens: 1_050_000,
  };

  it('leaves the list price at standard speed', () => {
    expect(priceAtServiceTier(PRICE, null)).toBe(PRICE);
    expect(priceAtServiceTier(PRICE, 'default')).toBe(PRICE);
  });

  it.each(['priority', 'fast'])('doubles every rate at %s', (tier) => {
    expect(priceAtServiceTier(PRICE, tier)).toEqual({
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite: null,
      tiers: [
        {
          input: 8,
          output: 30,
          cacheRead: 0.4,
          cacheWrite: 10,
          aboveContextTokens: 272_000,
        },
      ],
      contextTokens: 1_050_000,
    });
  });

  it('prices no tier whose price nobody states', () => {
    expect(priceAtServiceTier(PRICE, 'ultrafast')).toBeNull();
    expect(priceAtServiceTier(null, 'priority')).toBeNull();
  });
});

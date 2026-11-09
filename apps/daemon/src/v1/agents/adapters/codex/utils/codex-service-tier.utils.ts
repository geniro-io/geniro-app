import type { ModelPrice, ModelPriceRates } from '../../../utils/model-prices';
import type { AgentModelParameterListing } from '../../adapter.types';
import {
  CODEX_CONFIG_FLAG,
  CODEX_FAST_PRICE_FACTOR,
  CODEX_FAST_SERVICE_TIERS,
  CODEX_SERVICE_TIER_KEY,
  CODEX_STANDARD_SERVICE_TIER,
} from '../codex.const';
import type { CodexModelEntry } from './codex-models.utils';

/** The speed tier a turn asks for; null leaves the thread on its own. */
export function codexServiceTierOf(
  parameters: Record<string, string> | null | undefined,
): string | null {
  const tier = parameters?.[CODEX_SERVICE_TIER_KEY]?.trim();
  return tier ? tier : null;
}

/** The same choice as a `-c` override, for a `codex exec` with no turn to carry it. */
export function codexServiceTierArgs(
  parameters: Record<string, string> | null | undefined,
): string[] {
  const tier = codexServiceTierOf(parameters);
  return tier === null
    ? []
    : [CODEX_CONFIG_FLAG, `${CODEX_SERVICE_TIER_KEY}=${JSON.stringify(tier)}`];
}

/**
 * The settings one model offers beyond its effort and window: its speed tiers.
 * With no model named, those of the one `model/list` marks as the default.
 */
export function codexModelParameterListing(
  model: string | null,
  models: readonly CodexModelEntry[],
): AgentModelParameterListing {
  const name = model ?? 'the default model';
  if (models.length === 0) {
    return {
      parameters: [],
      unavailableReason: `codex could not be asked which settings ${name} offers`,
      exact: false,
    };
  }
  const entry = models.find((candidate) =>
    model === null ? candidate.isDefault : candidate.id === model,
  );
  const exact = model !== null && entry !== undefined;
  if (entry === undefined || entry.serviceTiers.length === 0) {
    return {
      parameters: [],
      unavailableReason: `${name} offers no settings beyond the ones already on screen`,
      exact,
    };
  }
  const tiers = entry.serviceTiers;
  return {
    parameters: [
      {
        id: CODEX_SERVICE_TIER_KEY,
        label: 'Fast mode',
        values: [
          { id: CODEX_STANDARD_SERVICE_TIER, label: 'Off' },
          ...tiers.map((tier) => ({
            id: tier.id,
            label: tiers.length === 1 ? 'On' : tier.name,
            ...(tier.description ? { description: tier.description } : {}),
          })),
        ],
        current: entry.defaultServiceTier,
      },
    ],
    unavailableReason: null,
    exact,
  };
}

function scaled<Rates extends ModelPriceRates>(
  rates: Rates,
  factor: number,
): Rates {
  const times = (rate: number | null): number | null =>
    rate === null ? null : rate * factor;
  return {
    ...rates,
    input: rates.input * factor,
    output: rates.output * factor,
    cacheRead: times(rates.cacheRead),
    cacheWrite: times(rates.cacheWrite),
  };
}

/**
 * A model's list price at a speed tier. A tier whose price nobody states has
 * none, so its turns read "not measured" rather than a smaller figure.
 */
export function priceAtServiceTier(
  price: ModelPrice | null,
  tier: string | null,
): ModelPrice | null {
  if (price === null || tier === null || tier === CODEX_STANDARD_SERVICE_TIER) {
    return price;
  }
  if (!CODEX_FAST_SERVICE_TIERS.includes(tier)) {
    return null;
  }
  return {
    ...scaled(price, CODEX_FAST_PRICE_FACTOR),
    tiers: price.tiers.map((above) => scaled(above, CODEX_FAST_PRICE_FACTOR)),
  };
}

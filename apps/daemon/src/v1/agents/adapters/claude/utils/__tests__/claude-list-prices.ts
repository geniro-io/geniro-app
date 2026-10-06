import {
  lookupModelPrice,
  type ModelPrice,
  parseModelPriceCatalog,
} from '../../../../utils/model-prices';
import type { ClaudeListPrices } from '../claude-delegate-cost.utils';

/**
 * The `anthropic` entries of the public catalog the claude cost specs price
 * with, transcribed from `https://models.dev/api.json` as fetched on
 * 2026-10-05 — read through the REAL catalog parser, so a spec prices exactly
 * the way the daemon does.
 *
 * `scale` multiplies every rate, for the spec that proves the calibration
 * absorbs a catalog whose prices moved.
 */
export function catalogClaudePrices(scale = 1): ClaudeListPrices {
  const rates = (
    input: number,
    output: number,
    cacheRead: number,
    cacheWrite: number,
  ) => ({
    cost: {
      input: input * scale,
      output: output * scale,
      cache_read: cacheRead * scale,
      cache_write: cacheWrite * scale,
    },
  });
  const table = parseModelPriceCatalog({
    anthropic: {
      models: {
        'claude-fable-5': rates(10, 50, 1, 12.5),
        'claude-opus-5': rates(5, 25, 0.5, 6.25),
        'claude-opus-4-8': rates(5, 25, 0.5, 6.25),
        'claude-opus-4-7': rates(5, 25, 0.5, 6.25),
        'claude-opus-4-6': rates(5, 25, 0.5, 6.25),
        'claude-sonnet-5': rates(2, 10, 0.2, 2.5),
        'claude-sonnet-4-6': rates(3, 15, 0.3, 3.75),
        'claude-haiku-4-5': rates(1, 5, 0.1, 1.25),
      },
    },
  });
  return (model: string): ModelPrice | null =>
    lookupModelPrice(table, 'anthropic', model);
}

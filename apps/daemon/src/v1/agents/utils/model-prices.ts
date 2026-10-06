import { asArray, asRecord } from './json-util';

/**
 * Model LIST prices, as the public models.dev catalog states them — the pure
 * half of `services/model-price-catalog.service.ts`: the parser, the lookup and
 * the arithmetic, with no network, no disk and no clock.
 *
 * Why a public catalog rather than a table in this repo: a table has to be
 * edited for every model a vendor ships, for every CLI, and it goes quietly
 * wrong the day nobody does. The catalog is maintained by people whose job is
 * exactly that, and the daemon reads it on its own schedule.
 *
 * Every price is in US DOLLARS PER MILLION TOKENS, exactly as the catalog
 * publishes it. A model the catalog does not list — or lists without a usable
 * price — has NO price here, and the callers turn that into "cost not
 * measured" (null), never into $0.
 */

/**
 * The one host the daemon reads prices from. A constant rather than config:
 * "one fixed host, no credential, no user data" is the shape the root
 * `CLAUDE.md` admits this outbound call under, and a knob is how it would come
 * to be pointed somewhere else.
 */
export const MODEL_PRICE_CATALOG_URL = 'https://models.dev/api.json';

/**
 * The catalog providers an adapter may price its models under — the provider
 * ids as models.dev spells them. Only these are parsed and kept: the catalog
 * holds ~226 providers and ~5MB, and nothing here prices a model from any of
 * the others. A CLI whose models a new provider prices adds the id here and
 * declares it on its own `AdapterConfig.usage.listPrice`.
 */
export const MODEL_PRICE_PROVIDERS = ['openai', 'anthropic'] as const;
export type ModelPriceProvider = (typeof MODEL_PRICE_PROVIDERS)[number];

/** One set of per-million-token rates. */
export interface ModelPriceRates {
  /** Fresh (uncached) prompt tokens. */
  readonly input: number;
  /** Completion tokens — reasoning included, which every provider bills as output. */
  readonly output: number;
  /** Prompt tokens served from the cache, or null when the catalog names no rate. */
  readonly cacheRead: number | null;
  /** Prompt tokens written to the cache, or null when the catalog names no rate. */
  readonly cacheWrite: number | null;
}

/**
 * Rates that replace the base ones for a request whose PROMPT is larger than
 * {@link aboveContextTokens} — models.dev's `tiers[]` entry of type `context`
 * (OpenAI's long-context pricing past 272k, for one).
 */
export interface ModelPriceTier extends ModelPriceRates {
  readonly aboveContextTokens: number;
}

/** One model's list price: its base rates and any context tiers above them. */
export interface ModelPrice extends ModelPriceRates {
  /** Ascending by {@link ModelPriceTier.aboveContextTokens}. */
  readonly tiers: readonly ModelPriceTier[];
}

/**
 * The synchronous price lookup an adapter is handed.
 *
 * Synchronous on purpose: it is asked on the line that closes a turn, inside a
 * stream mapper that cannot await, so the catalog is held in memory and the
 * network is someone else's schedule.
 *
 * The model id is matched EXACTLY against the catalog's own key. Whatever a
 * CLI spells differently from the vendor's API id is the ADAPTER's to
 * canonicalise before asking (claude's `claude-opus-5[1m]` → `claude-opus-5`),
 * because which spellings a CLI invents is a fact about that CLI.
 */
export interface ModelPriceLookup {
  priceOf(provider: ModelPriceProvider, model: string): ModelPrice | null;
}

/** A lookup that knows no prices — every model reads as "not measured". */
export const NO_MODEL_PRICES: ModelPriceLookup = { priceOf: () => null };

/** The parsed catalog: provider → model id → price. */
export type ModelPriceTable = ReadonlyMap<
  ModelPriceProvider,
  ReadonlyMap<string, ModelPrice>
>;

/** A token breakdown, the way billing splits it. Absent figures count as zero. */
export interface PricedTokens {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}

/**
 * Read a models.dev reply — or the projection of one this daemon persisted —
 * into a price table. Only {@link MODEL_PRICE_PROVIDERS} are read.
 *
 * Validated per ENTRY, never per file: one malformed model must not cost every
 * other model its price. An entry is refused when its input or output rate is
 * not a finite non-negative number, and when BOTH are zero — for these
 * providers a zero list price is a placeholder far more often than a free
 * model, and "not measured" is the honest reading of a placeholder.
 *
 * `context_over_200k` is deliberately not read: every entry measured carrying
 * it also carries the same figures as a `tiers[]` entry, which is the general
 * form (measured 2026-10-05: no openai/anthropic model has the former alone).
 */
export function parseModelPriceCatalog(raw: unknown): ModelPriceTable {
  const table = new Map<ModelPriceProvider, Map<string, ModelPrice>>();
  const root = asRecord(raw);
  for (const provider of MODEL_PRICE_PROVIDERS) {
    const models = asRecord(asRecord(root?.[provider])?.models);
    if (models === null) {
      continue;
    }
    const prices = new Map<string, ModelPrice>();
    for (const [id, entry] of Object.entries(models)) {
      const price = readPrice(asRecord(asRecord(entry)?.cost));
      if (price !== null) {
        prices.set(id, price);
      }
    }
    if (prices.size > 0) {
      table.set(provider, prices);
    }
  }
  return table;
}

/** How many model prices a table holds, across every provider. */
export function countModelPrices(table: ModelPriceTable): number {
  let count = 0;
  for (const prices of table.values()) {
    count += prices.size;
  }
  return count;
}

/** One model's price, by exact id, or null. */
export function lookupModelPrice(
  table: ModelPriceTable,
  provider: ModelPriceProvider,
  model: string,
): ModelPrice | null {
  return table.get(provider)?.get(model) ?? null;
}

/**
 * A table back in the catalog's own shape, so what is persisted is read by the
 * SAME parser as what is fetched — one reader for both sources, and a stored
 * file that a later build parses differently is simply re-validated by it.
 */
export function modelPriceCatalogShape(
  table: ModelPriceTable,
): Record<string, { models: Record<string, { cost: unknown }> }> {
  const shape: Record<string, { models: Record<string, { cost: unknown }> }> =
    {};
  for (const [provider, prices] of table) {
    const models: Record<string, { cost: unknown }> = {};
    for (const [id, price] of prices) {
      models[id] = {
        cost: {
          ...catalogRates(price),
          tiers: price.tiers.map((tier) => ({
            ...catalogRates(tier),
            tier: { type: 'context', size: tier.aboveContextTokens },
          })),
        },
      };
    }
    shape[provider] = { models };
  }
  return shape;
}

/**
 * The rates a request is billed at, given how large its prompt was: the
 * highest tier whose threshold the prompt EXCEEDS, else the base rates. A null
 * prompt size (not measured) bills at the base rates.
 */
export function ratesForPrompt(
  price: ModelPrice,
  promptTokens: number | null,
): ModelPriceRates {
  let rates: ModelPriceRates = price;
  if (promptTokens === null) {
    return rates;
  }
  for (const tier of price.tiers) {
    if (promptTokens > tier.aboveContextTokens) {
      rates = tier;
    }
  }
  return rates;
}

/**
 * What a token breakdown costs at the given rates, in dollars.
 *
 * A cache rate the catalog does not name falls back to the INPUT rate: those
 * tokens are prompt tokens, and with no cheaper rate published the input rate
 * is what the list says they cost. For a cache WRITE that is also exactly how
 * OpenAI bills one on a model without a cache-write price (a write is ordinary
 * input there). It can only over-state a cache READ on a model whose discount
 * the catalog omits — never invent a discount nobody published.
 */
export function tokenCostUsd(
  rates: ModelPriceRates,
  tokens: PricedTokens,
): number {
  const perMillion =
    (tokens.inputTokens ?? 0) * rates.input +
    (tokens.outputTokens ?? 0) * rates.output +
    (tokens.cacheReadTokens ?? 0) * (rates.cacheRead ?? rates.input) +
    (tokens.cacheWriteTokens ?? 0) * (rates.cacheWrite ?? rates.input);
  return perMillion / 1_000_000;
}

function readPrice(cost: Record<string, unknown> | null): ModelPrice | null {
  const base = readRates(cost);
  if (base === null) {
    return null;
  }
  const tiers: ModelPriceTier[] = [];
  for (const entry of asArray(cost?.tiers)) {
    const tierRecord = asRecord(entry);
    const tier = asRecord(tierRecord?.tier);
    const size = rate(tier?.size);
    const rates = readRates(tierRecord);
    if (tier?.type !== 'context' || size === null || size <= 0 || !rates) {
      continue;
    }
    tiers.push({ ...rates, aboveContextTokens: size });
  }
  tiers.sort((a, b) => a.aboveContextTokens - b.aboveContextTokens);
  return { ...base, tiers };
}

function readRates(
  cost: Record<string, unknown> | null,
): ModelPriceRates | null {
  const input = rate(cost?.input);
  const output = rate(cost?.output);
  if (input === null || output === null || (input === 0 && output === 0)) {
    return null;
  }
  return {
    input,
    output,
    cacheRead: rate(cost?.cache_read),
    cacheWrite: rate(cost?.cache_write),
  };
}

function catalogRates(rates: ModelPriceRates): Record<string, number> {
  return {
    input: rates.input,
    output: rates.output,
    ...(rates.cacheRead === null ? {} : { cache_read: rates.cacheRead }),
    ...(rates.cacheWrite === null ? {} : { cache_write: rates.cacheWrite }),
  };
}

/** A finite, non-negative number, or null. */
function rate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

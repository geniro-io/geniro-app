import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';

import { environment } from '../../../environments';
import { atomicWriteSync } from '../../../utils/atomic-file';
import {
  countModelPrices,
  lookupModelPrice,
  MODEL_PRICE_CATALOG_URL,
  type ModelPrice,
  modelPriceCatalogShape,
  type ModelPriceLookup,
  type ModelPriceProvider,
  type ModelPriceTable,
  parseModelPriceCatalog,
} from '../utils/model-prices';

/** The persisted copy, under the daemon's userData dir. */
export const MODEL_PRICES_FILE_NAME = 'model-prices.json';

/**
 * How old the held catalog may get before it is asked for again.
 *
 * Twelve hours: list prices move a few times a year, and a new model appearing
 * is the only change worth catching quickly — half a day is quick enough for
 * that and costs the public host two requests a day per machine at most.
 */
export const MODEL_PRICES_REFRESH_AFTER_MS = 12 * 60 * 60_000;

/**
 * How often a long-running daemon checks whether the catalog has gone stale.
 * A check that finds it fresh does nothing — this is a clock, not a fetch rate.
 */
const STALENESS_CHECK_EVERY_MS = 60 * 60_000;

/** A fetch that has not answered in this long is abandoned until next time. */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Refuse a reply (or a stored file) larger than this. The whole catalog was
 * ~5.3MB when measured (2026-10-05); the stored projection of the two
 * providers read from it is a few tens of KB. The cap bounds the work a
 * runaway reply can cause, not the catalog's expected size.
 */
const MAX_REPLY_BYTES = 32 * 1024 * 1024;
const MAX_STORED_BYTES = 4 * 1024 * 1024;

/** The fetch this service makes — `globalThis.fetch`'s shape, narrowed. */
export type ModelPriceFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Constructor options — test seams, not user config. */
export interface ModelPriceCatalogOptions {
  /** The stored copy; defaults to `<userData>/model-prices.json`. */
  file?: string;
  /** Clock (test seam). */
  now?: () => number;
  /**
   * The network. `null` turns fetching OFF, which is what the test
   * environment gets, so no spec and no booted test container reaches out.
   */
  fetch?: ModelPriceFetch | null;
}

/** What is persisted: when, and the catalog's own shape for two providers. */
interface StoredCatalog {
  fetchedAt: number;
  catalog: unknown;
}

/**
 * The public model price catalog (models.dev), held in memory and on disk, so
 * an adapter can put a dollar figure on a turn its CLI does not price itself.
 *
 * **Lookups are synchronous and never touch the network.** A price is asked on
 * the line that closes a turn, inside a mapper that cannot wait, so the answer
 * is whatever this process holds: the last good copy, read from
 * `<userData>/model-prices.json` at boot (so pricing works offline and before
 * the first fetch of a launch), replaced in place whenever a fetch succeeds.
 *
 * **Fetching is best-effort and never anyone's failure.** Once at boot when the
 * held copy is older than {@link MODEL_PRICES_REFRESH_AFTER_MS} (or absent), and
 * again whenever a running daemon finds it that old. Not awaited by the boot,
 * single-flight, bounded by a timeout, and every failure — no network, a 5xx, a
 * reply that does not parse or prices nothing — is logged and swallowed with
 * the last good copy kept. A model nothing priced reads as "not measured".
 *
 * **What goes out, and what does not.** One anonymous GET of one fixed URL
 * ({@link MODEL_PRICE_CATALOG_URL}): no credential, no cookie, no query, nothing
 * about the user or their conversations. This is the fourth outbound shape the
 * root `CLAUDE.md` admits under *Constraints*.
 */
@Injectable()
export class ModelPriceCatalog
  implements ModelPriceLookup, OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(ModelPriceCatalog.name);
  private readonly file: string;
  private readonly now: () => number;
  private readonly fetchFn: ModelPriceFetch | null;
  private table: ModelPriceTable | null = null;
  /** When the held table was fetched; null when nothing is held. */
  private fetchedAt: number | null = null;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(@Optional() options?: ModelPriceCatalogOptions) {
    this.file =
      options?.file ?? join(environment.userDataDir, MODEL_PRICES_FILE_NAME);
    this.now = options?.now ?? Date.now;
    this.fetchFn =
      options?.fetch === undefined
        ? environment.fetchModelPrices
          ? (url, init) => fetch(url, init)
          : null
        : options.fetch;
  }

  /** Load the stored copy, then refresh it behind the boot when it is stale. */
  onModuleInit(): void {
    this.load();
    void this.refreshIfStale();
    if (this.fetchFn !== null) {
      this.timer = setInterval(() => {
        void this.refreshIfStale();
      }, STALENESS_CHECK_EVERY_MS);
      this.timer.unref?.();
    }
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One model's list price, by the catalog's exact id — or null. */
  priceOf(provider: ModelPriceProvider, model: string): ModelPrice | null {
    return lookupModelPrice(this.load(), provider, model);
  }

  /**
   * Fetch the catalog when the held copy is missing or older than
   * {@link MODEL_PRICES_REFRESH_AFTER_MS}. Never rejects.
   */
  refreshIfStale(): Promise<void> {
    this.load();
    if (this.fetchFn === null) {
      return Promise.resolve();
    }
    // A stamp from the FUTURE (a clock set back since it was written) reads as
    // stale rather than as fresh until that moment arrives.
    const age = this.fetchedAt === null ? null : this.now() - this.fetchedAt;
    if (age !== null && age >= 0 && age < MODEL_PRICES_REFRESH_AFTER_MS) {
      return Promise.resolve();
    }
    if (this.inFlight === null) {
      this.inFlight = this.refresh(this.fetchFn).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async refresh(fetchFn: ModelPriceFetch): Promise<void> {
    try {
      const reply = await fetchFn(MODEL_PRICE_CATALOG_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (!reply.ok) {
        throw new Error(`HTTP ${reply.status}`);
      }
      const text = await reply.text();
      if (text.length > MAX_REPLY_BYTES) {
        throw new Error(`reply of ${text.length} bytes is implausibly large`);
      }
      const table = parseModelPriceCatalog(JSON.parse(text) as unknown);
      if (countModelPrices(table) === 0) {
        // A reply that parses but prices nothing is a format change or an
        // outage page, not "every model is now free of charge" — keep the
        // copy that did price them.
        throw new Error('the reply priced no model this daemon reads');
      }
      this.table = table;
      this.fetchedAt = this.now();
      this.save(table, this.fetchedAt);
      this.logger.log(
        `model price catalog refreshed: ${countModelPrices(table)} model prices`,
      );
    } catch (err) {
      this.logger.warn(
        `model price catalog refresh failed (keeping the last good copy): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** The held table, read from disk the first time it is needed. */
  private load(): ModelPriceTable {
    if (this.table !== null) {
      return this.table;
    }
    let table: ModelPriceTable = new Map();
    try {
      if (statSync(this.file).size > MAX_STORED_BYTES) {
        throw new Error('stored model price catalog is implausibly large');
      }
      const stored = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (isStoredCatalog(stored)) {
        table = parseModelPriceCatalog(stored.catalog);
        this.fetchedAt = countModelPrices(table) > 0 ? stored.fetchedAt : null;
      }
    } catch {
      // Missing or malformed: nothing is priced until a fetch succeeds, which
      // is exactly a fresh install's state. The next good fetch replaces the
      // file wholesale, so a corrupt one repairs itself.
    }
    this.table = table;
    return table;
  }

  private save(table: ModelPriceTable, fetchedAt: number): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const stored: StoredCatalog = {
        fetchedAt,
        catalog: modelPriceCatalogShape(table),
      };
      atomicWriteSync(this.file, JSON.stringify(stored));
    } catch (err) {
      this.logger.warn(
        `model price catalog write failed (this session only, lost on restart): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function isStoredCatalog(value: unknown): value is StoredCatalog {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const stored = value as Partial<StoredCatalog>;
  return (
    typeof stored.fetchedAt === 'number' &&
    Number.isFinite(stored.fetchedAt) &&
    'catalog' in stored
  );
}

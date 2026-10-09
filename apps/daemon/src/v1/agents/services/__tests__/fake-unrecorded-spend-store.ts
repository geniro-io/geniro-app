import type { UnrecordedSpendStore } from '../unrecorded-spend.store';

/**
 * An in-memory {@link UnrecordedSpendStore} for specs that drive the live
 * plane without a database.
 *
 * The real store's only side effect is a column on the run row, written
 * behind the caller; a spec of the live plane has no row to write to. What it
 * keeps is the contract the plane relies on — a figure set is held, null or
 * zero removes it, a clear empties the run — so a spec asserting
 * that the plane persisted something asserts on that contract rather than on
 * a mock's convenience. The real store's own spec covers the database half.
 */
export class FakeUnrecordedSpendStore {
  /** run → owner → dollars, as the column would hold it. */
  readonly runs = new Map<string, Map<string, number>>();

  constructor(seed: Record<string, Record<string, number>> = {}) {
    for (const [runId, owners] of Object.entries(seed)) {
      this.runs.set(runId, new Map(Object.entries(owners)));
    }
  }

  set(runId: string, ownerKey: string, costUsd: number | null): void {
    const spend = this.runs.get(runId) ?? new Map<string, number>();
    if (costUsd !== null && Number.isFinite(costUsd) && costUsd > 0) {
      spend.set(ownerKey, costUsd);
    } else {
      spend.delete(ownerKey);
    }
    this.store(runId, spend);
  }

  clearRun(runId: string): void {
    this.runs.delete(runId);
  }

  loadAll(): Promise<Map<string, Map<string, number>>> {
    return Promise.resolve(
      new Map([...this.runs].map(([runId, spend]) => [runId, new Map(spend)])),
    );
  }

  /** One run's entries as a plain object — for assertions. */
  of(runId: string): Record<string, number> {
    return Object.fromEntries(this.runs.get(runId) ?? []);
  }

  asStore(): UnrecordedSpendStore {
    return this as unknown as UnrecordedSpendStore;
  }

  private store(runId: string, spend: Map<string, number>): void {
    if (spend.size === 0) {
      this.runs.delete(runId);
    } else {
      this.runs.set(runId, spend);
    }
  }
}

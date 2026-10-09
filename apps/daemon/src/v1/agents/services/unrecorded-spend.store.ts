import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { RunDao } from '../dao/run.dao';
import {
  isOutstanding,
  readUnrecordedSpend,
  writeUnrecordedSpend,
} from '../utils/unrecorded-spend';
import { AgentEventBus } from './agent-events.bus';

/** One run's half of the store: its entries once read, and its write queue. */
interface RunSpend {
  /** Null until this process has read the row (or after a write failed). */
  spend: Map<string, number> | null;
  /** Every write for this run, in order — see {@link UnrecordedSpendStore}. */
  chain: Promise<void>;
}

/**
 * The durable half of the live plane's running spend — `Run.unrecordedSpend`,
 * kept in step with `PartialStreamService`, which is its only writer.
 *
 * WRITE-BEHIND, and serialized per run: the live plane's methods are
 * synchronous and must never fail a turn (they run inside the persist chain),
 * so a change is queued here and the caller moves on. One chain per run is
 * what keeps the order honest — a reading followed by its retirement must
 * land in that order, or a turn that ended would leave its last figure on the
 * row and the money would read as still owed after its `turn_complete`
 * recorded it.
 *
 * Each queued write is a read-modify-write of the whole map against this
 * process's copy, read from the row once: entries written before a restart
 * are merged with, never overwritten by, the first change after it. A write
 * that changes nothing is skipped, so the turn-boundary clears every chat
 * makes cost one read per run per process and no writes.
 */
@Injectable()
export class UnrecordedSpendStore implements OnModuleInit {
  private readonly logger = new Logger(UnrecordedSpendStore.name);
  private readonly runs = new Map<string, RunSpend>();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly bus: AgentEventBus,
  ) {}

  onModuleInit(): void {
    // A deleted run's row is gone; its entry would only ever be read again by
    // a write that matches nothing.
    this.bus.allDeleted().subscribe((runId) => {
      this.runs.delete(runId);
    });
  }

  /** Record one owner's outstanding figure; null or zero means none. */
  set(runId: string, ownerKey: string, costUsd: number | null): void {
    this.update(runId, (spend) => {
      if (isOutstanding(costUsd)) {
        spend.set(ownerKey, costUsd);
      } else {
        spend.delete(ownerKey);
      }
    });
  }

  /** Drop every owner's figure — the run's turn or pass is over. */
  clearRun(runId: string): void {
    this.update(runId, (spend) => {
      spend.clear();
    });
  }

  /**
   * Every run's outstanding entries, read from the database — what the boot
   * rehydration seeds the live plane from. Primes this store's copy too, so
   * the first change after a restart does not read the row again.
   */
  async loadAll(): Promise<Map<string, Map<string, number>>> {
    const out = new Map<string, Map<string, number>>();
    const rows = await this.runDao.listRunsWithUnrecordedSpend(this.em.fork());
    for (const row of rows) {
      const spend = readUnrecordedSpend(row.unrecordedSpend);
      if (spend.size === 0) {
        continue;
      }
      out.set(row.id, spend);
      const entry = this.entryOf(row.id);
      entry.spend ??= new Map(spend);
    }
    return out;
  }

  /** Resolves once every write queued so far for `runId` has landed. */
  async flushed(runId: string): Promise<void> {
    await this.runs.get(runId)?.chain;
  }

  private update(
    runId: string,
    mutate: (spend: Map<string, number>) => void,
  ): void {
    const entry = this.entryOf(runId);
    entry.chain = entry.chain
      .then(async () => {
        const em = this.em.fork();
        entry.spend ??= readUnrecordedSpend(
          await this.runDao.unrecordedSpendOf(runId, em),
        );
        const before = writeUnrecordedSpend(entry.spend);
        mutate(entry.spend);
        const after = writeUnrecordedSpend(entry.spend);
        if (after !== before) {
          await this.runDao.setUnrecordedSpend(runId, after, em);
        }
      })
      .catch((err: unknown) => {
        // Forget the copy: it may now disagree with the row, and the next
        // change re-reads the row rather than writing over it from a guess.
        entry.spend = null;
        this.logger.warn(
          `could not record the outstanding spend of run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  private entryOf(runId: string): RunSpend {
    let entry = this.runs.get(runId);
    if (!entry) {
      entry = { spend: null, chain: Promise.resolve() };
      this.runs.set(runId, entry);
    }
    return entry;
  }
}

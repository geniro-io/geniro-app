import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { ItemDao } from '../dao/item.dao';

/**
 * The ONE place a chat run's item `seq` values come from.
 *
 * A run's items are ordered by `seq`, and the renderer de-dupes the
 * replay/live seam BY seq — so two rows sharing one value are not a cosmetic
 * problem: the second is dropped and never rendered. This existed as a real,
 * reproducible defect. A turn seeded a CLOSURE-LOCAL counter once
 * (`let seq = maxSeq + 1`) and incremented it per item, while the mid-turn
 * follow-up path (`deliverIntoRunningTurn`, the message handed to a turn
 * already running) re-read `maxSeq` FROM THE DATABASE. The database cannot see
 * a counter's reservations, so the follow-up was handed the value the turn had
 * already reserved for its next durable item — every time, not occasionally.
 * Observed on a live transcript: a user message and the assistant's reply both
 * at seq 5927, with the reply absent from the transcript on screen while
 * sitting in the table.
 *
 * So allocation stops being something a caller does for itself. Reservations
 * are held HERE, in one per-run tail, and the database is read only to SEED a
 * run the current daemon launch has not written to yet. That is sound because
 * this process is the only writer: the instance lock admits one daemon per
 * userData directory, and every chat write path now allocates through this.
 *
 * Concurrency is real and is why {@link reserve} serializes. The two writers
 * above run on INDEPENDENT promise chains — a turn's `enqueue` chain and an
 * HTTP request handler — so a bare read-modify-write on the tail would hand
 * both the same value across its `await`. Each run therefore gets its own
 * chain, and callers of different runs never wait on each other.
 *
 * Workflow runs deliberately do NOT come through here: the graph executor is a
 * single owner writing on one serialized chain from a counter it starts at 0,
 * with no second writer to collide with (see `GraphExecutorService`).
 */
@Injectable()
export class ItemSeqAllocator {
  /** Highest seq RESERVED per run — not necessarily written yet. */
  private readonly tails = new Map<string, number>();

  /** Per-run serialization, so two concurrent reserves cannot interleave. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
  ) {}

  /**
   * Reserve `count` consecutive seq values for one run and return the FIRST.
   *
   * `count` exists for the callers that write a known burst under one logical
   * step (the boot reconcile's terminal item plus one row per unanswered
   * approval). A caller writing an open-ended stream calls this per item
   * instead — which is the point: an item's place in the order is fixed when
   * it is written, so a row appended by another writer in between lands
   * between them rather than on top of one.
   */
  async reserve(runId: string, count = 1): Promise<number> {
    if (count < 1) {
      throw new RangeError(`seq reserve count must be >= 1, got ${count}`);
    }
    // Chained off the previous reserve for this run WHATEVER its outcome: a
    // failed seed (a transient DB read error) must not wedge the run's
    // allocator forever, and the next caller re-seeds from the database.
    const previous = this.chains.get(runId) ?? Promise.resolve();
    const next = previous.then(
      () => this.allocate(runId, count),
      () => this.allocate(runId, count),
    );
    // The stored link never rejects, so a caller that lets its own error
    // propagate cannot produce an unhandled rejection here as well.
    this.chains.set(
      runId,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * Drop a run's reservation state — called when the run and its items are
   * destroyed. Purely hygiene: run ids are UUIDs, so a forgotten entry can
   * never be re-seeded against different rows, but a daemon left running for
   * days would otherwise keep one integer per chat it ever wrote to.
   */
  forget(runId: string): void {
    this.tails.delete(runId);
    this.chains.delete(runId);
  }

  private async allocate(runId: string, count: number): Promise<number> {
    // The database is consulted ONCE per run per daemon launch. After that the
    // tail is ahead of (or equal to) what is committed — a row may still be in
    // flight — and re-reading would hand back a value already reserved, which
    // is the exact defect this class exists to remove.
    const reserved = this.tails.get(runId);
    const base = reserved ?? (await this.itemDao.maxSeq(runId, this.em.fork()));
    this.tails.set(runId, base + count);
    return base + 1;
  }
}

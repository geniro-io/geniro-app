import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, type OnModuleInit, Optional } from '@nestjs/common';

import type { Item } from '../../runs/entity/item.entity';
import type { ItemKind } from '../../runs/runs.types';
import type { KindRowsView } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { AgentEventBus } from './agent-events.bus';
import { ItemCallIndexService } from './item-call-index.service';
import { ItemSeqAllocator } from './item-seq.allocator';

/**
 * Payload characters held across every run/kind set; past it the least
 * recently read sets are dropped first. A budget of characters rather than of
 * sets, so many small sets (a poll's `call_result` rows across every run) never
 * push out the one large set a thread open is about to read again.
 */
const MAX_HELD_PAYLOAD_CHARS = 32 * 1024 * 1024;

/**
 * Seqs read per statement: a run first read cold (a long run's `subagent_info`
 * is a megabyte of payload) is read in windows with the event loop turning
 * between them.
 */
const READ_WINDOW_SEQS = 2_000;

interface Held {
  /** Every row of the kinds at or below this seq is in `rows`. */
  through: number;
  rows: Item[];
  /** `ItemCallIndexService.stampEpoch` the rows were read under. */
  stampEpoch: number;
  chars: number;
}

/**
 * Every row of a few kinds of one run, read once and then only past what was
 * already read — for kinds whose payloads are never edited once written
 * (`turn_complete`, `subagent_info`, `call_result` …), which a read path otherwise
 * loads whole on every request. A run's `message` rows are not such a kind:
 * a user message is rewritten when it is acknowledged.
 *
 * Two columns of a written row are filled in later: `inCall`, which is why a
 * run that can hold calls is read only once its stamps are complete and read
 * again whenever every stamp is cleared (a chat's rows are all in its own
 * flow); and the promoted payload columns, which no reader of these rows uses.
 *
 * The high-water mark stops at `ItemSeqAllocator.writtenThrough`, so a row
 * whose seq was reserved but not yet written is read on a later call rather
 * than skipped for good. A deleted run is dropped.
 */
@Injectable()
export class RunKindRowsCache implements OnModuleInit {
  private readonly held = new Map<string, Held>();
  private readonly reading = new Map<
    string,
    Promise<Pick<Held, 'rows' | 'through'>>
  >();
  private heldChars = 0;
  /** Moves on every run deletion: a read that spans one keeps nothing it read. */
  private deletionEpoch = 0;
  private readonly maxHeldChars: number;

  constructor(
    private readonly itemDao: ItemDao,
    private readonly seqs: ItemSeqAllocator,
    private readonly bus: AgentEventBus,
    private readonly calls: ItemCallIndexService,
    private readonly em: EntityManager,
    /** Test seam only — nothing in the app passes it. */
    @Optional() maxHeldChars?: number,
  ) {
    this.maxHeldChars = maxHeldChars ?? MAX_HELD_PAYLOAD_CHARS;
  }

  onModuleInit(): void {
    this.bus.allDeleted().subscribe((runId) => {
      this.deletionEpoch += 1;
      const prefix = `${runId}\u0000`;
      for (const key of [...this.held.keys()]) {
        if (key.startsWith(prefix)) {
          this.drop(key);
        }
      }
    });
  }

  /**
   * The run's rows of `kinds`, in seq order — a snapshot the caller may not
   * mutate — holding every row at or below `atLeast` (a seq the caller has
   * already seen written), even when it joins a read that began earlier.
   */
  rowsOf(
    runId: string,
    kinds: readonly ItemKind[],
    atLeast = -1,
  ): Promise<readonly Item[]> {
    return this.rowsOfView(
      runId,
      { name: [...kinds].sort().join(','), kinds },
      atLeast,
    );
  }

  /**
   * The run's rows of `view`, in seq order. `atLeast` is a seq the caller has
   * seen written; `'fresh'` asks for a read begun after this call, for a caller
   * answering what the database holds now.
   */
  async rowsOfView(
    runId: string,
    view: KindRowsView,
    atLeast: number | 'fresh' = -1,
  ): Promise<readonly Item[]> {
    const key = `${runId}\u0000${view.name}`;
    const running = this.reading.get(key);
    if (running !== undefined) {
      if (atLeast === 'fresh') {
        await running.catch(() => undefined);
        return this.rowsOfView(runId, view);
      }
      const joined = await running;
      if (joined.through >= atLeast) {
        return joined.rows;
      }
      return this.rowsOfView(runId, view, atLeast);
    }
    const work = this.catchUp(key, runId, view).finally(() => {
      this.reading.delete(key);
    });
    this.reading.set(key, work);
    return (await work).rows;
  }

  private async catchUp(
    key: string,
    runId: string,
    view: KindRowsView,
  ): Promise<Pick<Held, 'rows' | 'through'>> {
    const deletionEpoch = this.deletionEpoch;
    if (await this.calls.holdsCalls(runId)) {
      await this.calls.ensureIndexed(runId);
    }
    const em = this.em.fork();
    const stampEpoch = this.calls.stampEpoch;
    const kept = this.held.get(key);
    this.drop(key);
    const held =
      kept !== undefined && kept.stampEpoch === stampEpoch
        ? kept
        : { through: -1, rows: [], stampEpoch, chars: 0 };
    const through = this.seqs.writtenThrough(
      runId,
      await this.itemDao.maxSeq(runId, em),
    );
    const added: Item[] = [];
    for (let from = held.through; from < through;) {
      const to = Math.min(from + READ_WINDOW_SEQS, through);
      const read = await this.itemDao.rowsOfKindsBetween(
        runId,
        view.kinds,
        from,
        to,
        em,
      );
      added.push(...(view.keep === undefined ? read : read.filter(view.keep)));
      from = to;
      if (from < through) {
        await yieldToEventLoop();
      }
    }
    if (through > held.through) {
      held.rows = [...held.rows, ...added];
      held.through = through;
      held.chars += added.reduce((sum, row) => sum + row.payload.length, 0);
    }
    if (this.deletionEpoch !== deletionEpoch) {
      return { rows: held.rows, through: held.through };
    }
    this.held.set(key, held);
    this.heldChars += held.chars;
    for (const oldest of this.held.keys()) {
      if (this.heldChars <= this.maxHeldChars || oldest === key) {
        break;
      }
      this.drop(oldest);
    }
    return { rows: held.rows, through: held.through };
  }

  private drop(key: string): void {
    const held = this.held.get(key);
    if (held !== undefined) {
      this.heldChars -= held.chars;
      this.held.delete(key);
    }
  }
}

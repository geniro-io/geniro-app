import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import type { RunWaterfallFold, ThreadTimeline } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { foldThreadTimeline, pairToolCalls } from '../utils/thread-timeline';
import { ChatWaterfallService } from './chat-waterfall.service';
import { ItemCallIndexService } from './item-call-index.service';

/** A snapshot's waterfall spans, and the timeline folded from them. */
export interface ThreadTimelineReading {
  fold: RunWaterfallFold;
  timeline: ThreadTimeline;
}

/** How many folded snapshots stay in memory — an analysis pages one source. */
const CACHE_SIZE = 8;

/**
 * One run's timeline as an analysis reads it — the waterfall's uncapped spans
 * plus every tool call's duration and the critical path — at a fixed snapshot.
 *
 * Cached per `(runId, snapshotSeq, working)`: an analysis reads the same source page
 * after page, a long thread's fold costs a full pass over its rows, and the
 * rows at or below a snapshot seq do not change kind, seq or time once written.
 */
@Injectable()
export class ThreadTimelineService {
  private readonly cache = new Map<string, ThreadTimelineReading>();

  constructor(
    private readonly em: EntityManager,
    private readonly waterfall: ChatWaterfallService,
    private readonly itemDao: ItemDao,
    private readonly calls: ItemCallIndexService,
  ) {}

  /** Null when the run has no rows at or below `snapshotSeq`. */
  async read(
    runId: string,
    snapshotSeq: number,
    /** The run was working at the snapshot — see `Run.analysisSourceWorking`. */
    working: boolean,
  ): Promise<ThreadTimelineReading | null> {
    const key = `${runId}\u0000${snapshotSeq}\u0000${working}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const em = this.em.fork();
    const folded = await this.waterfall.fold(runId, snapshotSeq, em, working);
    if (folded === null) {
      return null;
    }
    // Tool calls pair by the call they were made in, so the run's rows must be
    // stamped first — a boot re-stamp clears them and walks runs one by one.
    await this.calls.ensureIndexed(runId);
    const rows = await this.itemDao.toolCallTimes(runId, snapshotSeq, em);
    const to = Date.parse(folded.to);
    const timeline = foldThreadTimeline(
      {
        from: Date.parse(folded.from),
        to,
        turns: folded.turns,
        calls: folded.calls,
        waits: folded.waits,
      },
      pairToolCalls(rows, to, folded.working),
    );
    const reading = { fold: folded, timeline };
    this.cache.set(key, reading);
    if (this.cache.size > CACHE_SIZE) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return reading;
  }
}

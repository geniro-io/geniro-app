import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { PAYLOAD_REFS_VERSION, payloadRefsOf } from '../utils/payload-refs';

/** Rows stamped per transaction while filling one run's older rows. */
const STAMP_BATCH_SIZE = 200;

/**
 * A breath between batches: the sweep runs while the daemon is serving, and
 * better-sqlite3 is synchronous, so the event loop turns only between batches.
 */
const STAMP_BATCH_PAUSE_MS = 10;

/**
 * Fills `Item.payloadId` … on the rows written before those columns existed,
 * then marks the run (`Run.payloadRefsVersion`) so its lookups read the columns
 * instead of every payload. Every row written since is stamped as it is
 * inserted, so a run is swept at most once per rule version.
 */
@Injectable()
export class PayloadRefsSweepService {
  private readonly logger = new Logger(PayloadRefsSweepService.name);

  constructor(
    private readonly itemDao: ItemDao,
    private readonly runDao: RunDao,
    private readonly em: EntityManager,
  ) {}

  /** The boot entry point. Never throws; a run it misses is read the slow way. */
  async sweepAllQuietly(): Promise<void> {
    let runIds: string[];
    try {
      runIds = await this.runDao.listUnstampedPayloadRefs(
        PAYLOAD_REFS_VERSION,
        this.em.fork(),
      );
    } catch (err) {
      this.logger.warn(
        `payload-column sweep could not list runs: ${errorText(err)}`,
      );
      return;
    }
    let stamped = 0;
    for (const runId of runIds) {
      try {
        await this.stampRun(runId);
        stamped += 1;
      } catch (err) {
        this.logger.warn(
          `could not stamp payload columns of run ${runId}: ${errorText(err)}`,
        );
      }
    }
    if (stamped > 0) {
      this.logger.log(`stamped payload columns for ${stamped} run(s)`);
    }
  }

  private async stampRun(runId: string): Promise<void> {
    const em = this.em.fork();
    let after: { seq: number; id: string } | null = null;
    for (;;) {
      const rows = await this.itemDao.payloadRefsBatch(
        runId,
        after,
        STAMP_BATCH_SIZE,
        em,
      );
      if (rows.length === 0) {
        break;
      }
      // Only the rows whose columns change: rewriting a row, even to the NULLs
      // it holds, rewrites its whole record and the payload's overflow pages.
      const changed = rows.flatMap((row) => {
        const refs = payloadRefsOf(row.payload);
        return refs.payloadId === row.payloadId &&
          refs.toolNameLower === row.toolNameLower &&
          refs.parentToolUseId === row.parentToolUseId &&
          refs.callId === row.callId
          ? []
          : [{ id: row.id, refs }];
      });
      if (changed.length > 0) {
        await this.itemDao.rememberPayloadRefs(changed, em);
      }
      const last = rows[rows.length - 1]!;
      after = { seq: last.seq, id: last.id };
      await pause();
    }
    await this.runDao.markPayloadRefs(runId, PAYLOAD_REFS_VERSION, em);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pause(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, STAMP_BATCH_PAUSE_MS);
  });
}

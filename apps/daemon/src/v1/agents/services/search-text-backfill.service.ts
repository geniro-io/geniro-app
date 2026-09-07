import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, Optional } from '@nestjs/common';

import { environment } from '../../../environments';
import { ItemDao } from '../dao/item.dao';
import { searchIndexText } from '../utils/searchable-text';

/**
 * The marker that retires this migration, in the userData dir beside the
 * database it filled.
 *
 * A FILE rather than a settings key or a row, for the reason its sibling
 * `WorkflowTitleBackfillService` gives: the daemon never opens `settings.json`,
 * and a row would put a one-release migration's bookkeeping in the schema for
 * good.
 */
const MARKER_FILE = 'search-text-backfilled';

/** Rows read and written per pass. */
const BATCH_SIZE = 500;

/**
 * A breath between batches.
 *
 * This runs while the daemon is serving, so the sweep must not hold the event
 * loop for the length of a whole table. The granularity is the BATCH, not the
 * row: better-sqlite3 is synchronous, so the awaits inside a batch yield to
 * nothing and the loop turns once per batch.
 *
 * A real timer rather than `setImmediate` — that one runs in the check phase,
 * after poll, so ready I/O does get its turn; what a timer buys is a poll phase
 * that may BLOCK for the delay, which is where a socket with nothing ready yet
 * is actually waited on. I/O is what a chat turn is made of.
 */
const BATCH_PAUSE_MS = 10;

/**
 * A backstop on the loop rather than on the work.
 *
 * Every write removes a row from the predicate's set, so the sweep drains by
 * construction and this can only be reached if a write silently fails to stick.
 * Without it that would be an endless loop inside a live daemon; with it, it is
 * a bounded run and a warning naming what happened.
 */
const MAX_BATCHES = 10_000;

/**
 * One-time sweep filling `Item.searchText` for the rows that existed before the
 * column did.
 *
 * The column is written at the one insert seam (`utils/persist-item.ts`), so
 * everything said from now on is searchable without this. What it repairs is
 * history — on a real profile, ~160,000 rows of it — which is precisely what
 * the search is for: a term the user remembers from weeks ago is the case a
 * daemon-side search exists to answer, and it lives entirely in rows written
 * before this shipped.
 *
 * **ONCE, ever** — {@link MARKER_FILE} retires it. That is safe only because
 * the live insert path fills the column for every row created afterwards; the
 * marker and that write are two halves of one guarantee, and removing either
 * leaves a permanently unsearchable set. The sibling `UsageBackfillService`
 * reaches the opposite answer for the opposite reason — its sweep repairs a gap
 * that RECURS (a daemon killed between two writes), so it re-reads a bounded
 * window every launch and deliberately keeps no marker.
 *
 * **It runs AFTER the server is listening, and is never awaited.** Both
 * existing backfills are awaited on the boot path — one in `onModuleInit`, one
 * in the pre-listen callback — which is fine for their bounded work and wrong
 * for this: Nest awaits `onModuleInit` before the socket binds, so a sweep of
 * every item row would hold the pidfile write and the `GENIRO_DAEMON_READY`
 * print behind it, and the app would appear to hang on the first launch after
 * an update. Search being incomplete for a minute is the cheaper failure.
 */
@Injectable()
export class SearchTextBackfillService {
  private readonly logger = new Logger(SearchTextBackfillService.name);

  private readonly markerPath: string;

  constructor(
    private readonly itemDao: ItemDao,
    private readonly em: EntityManager,
    /** Test seam only — nothing in the app passes it. */
    @Optional() markerPath?: string,
  ) {
    this.markerPath = markerPath ?? join(environment.userDataDir, MARKER_FILE);
  }

  /**
   * Returns how many rows were filled, or null when the migration had already
   * run and this launch did nothing.
   */
  async backfill(): Promise<number | null> {
    if (await this.alreadyRun()) {
      return null;
    }
    const em = this.em.fork();
    let filled = 0;
    // The CURSOR, and it is what keeps the sweep linear: `searchText IS NULL` is
    // self-draining but deliberately unindexed, so each batch would otherwise
    // re-scan every row the batches before it had already filled. The figures
    // are on {@link ItemDao.missingSearchText}, which is the method they justify.
    let afterId: string | null = null;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const rows = await this.itemDao.missingSearchText(
        BATCH_SIZE,
        afterId,
        em,
      );
      if (rows.length === 0) {
        // A cursored pass finding nothing means "nothing AFTER the cursor",
        // which is not the same as "nothing left". A row whose write did not
        // stick stays null BEHIND the cursor, and retiring on this answer would
        // leave it unsearchable for good — the completeness the self-draining
        // predicate used to give away for free. So the cursor is dropped and one
        // uncursored pass decides: only that one may retire the sweep.
        if (afterId !== null) {
          afterId = null;
          continue;
        }
        await this.markDone();
        return filled;
      }
      // ONE transaction per batch rather than one per row. A plain `fork()`
      // opens none, so every `nativeUpdate` was its own implicit transaction —
      // on this database (`journal_mode=delete`, `synchronous=FULL`) that is a
      // journal write, an fsync and a journal delete per row. Measured on a
      // 188k-row replica of a real profile: 109.1s of writes one-per-row against
      // 6.0s wrapped.
      await em.transactional(async (tx) => {
        for (const row of rows) {
          await this.itemDao.rememberSearchText(
            row.id,
            this.textFor(row.payload),
            tx as EntityManager,
          );
          filled += 1;
        }
      });
      afterId = rows[rows.length - 1]?.id ?? afterId;
      await pause();
    }
    // Only reachable if a write is not sticking — the predicate is
    // self-draining otherwise. Deliberately NOT retired: the next launch should
    // try again rather than leave the rest of the table unsearchable for good.
    this.logger.warn(
      `search-text backfill stopped after ${MAX_BATCHES} batches with rows still unfilled — not retiring it`,
    );
    return filled;
  }

  /**
   * The flattened text for one stored payload.
   *
   * An unparseable payload is written as an empty string rather than skipped,
   * and that is load-bearing: the batch query selects on `searchText IS NULL`,
   * so a row this pass declines to write comes straight back in the next batch
   * and the sweep never drains. Empty is also the honest answer — there is
   * nothing in it to match.
   */
  private textFor(payload: string): string {
    try {
      return searchIndexText(JSON.parse(payload) as unknown) ?? '';
    } catch {
      return '';
    }
  }

  /** Whether a previous launch already ran this migration to completion. */
  private async alreadyRun(): Promise<boolean> {
    try {
      await access(this.markerPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retire the migration.
   *
   * A failed write is swallowed on the rule the whole sweep follows: the rows
   * are already filled, and the cost of not recording it is one more pass next
   * launch — which finds nothing to do, the predicate being empty by then.
   */
  private async markDone(): Promise<void> {
    try {
      await writeFile(this.markerPath, `${new Date().toISOString()}\n`, 'utf8');
    } catch (err) {
      this.logger.warn(
        `could not record the search-text backfill as done: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The boot entry point: never throws, and never delays the launch.
   *
   * Called from `main.ts`'s `onListening` AFTER the ready print and without
   * being awaited, so nothing about the handshake waits on it.
   */
  async backfillQuietly(): Promise<void> {
    try {
      const filled = await this.backfill();
      if (filled !== null && filled > 0) {
        this.logger.log(`filled search text for ${filled} transcript row(s)`);
      }
    } catch (err) {
      this.logger.warn(
        `search text backfill failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function pause(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, BATCH_PAUSE_MS);
  });
}

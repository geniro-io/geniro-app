import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, Optional } from '@nestjs/common';

import { environment } from '../../../environments';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import {
  CALL_MEMBERSHIP_SOURCE_KINDS,
  CALL_MEMBERSHIP_VERSION,
  callMembershipLookupOf,
  callMembershipOf,
  type CallMembershipRow,
  OUTSIDE_ANY_CALL,
} from '../utils/call-membership';
import type { CallStart } from '../utils/history-anchors';
import { asRecord, parseJsonColumn } from '../utils/json-util';

type RunLookup = ReturnType<typeof callMembershipLookupOf>;

/** Runs whose lookups are kept between rows; a run past it reloads on its next row. */
const LOOKUP_CACHE_SIZE = 64;

/**
 * Retires the boot sweep once it has run to the end under the current rule —
 * a file in the userData dir holding `CALL_MEMBERSHIP_VERSION` (a file, not a
 * settings key or a row: the daemon never opens `settings.json`, and a row
 * would put a sweep's bookkeeping in the schema). Only the SWEEP retires: every row
 * written since is stamped, and a conversation read still stamps an unstamped
 * run on demand.
 */
export const CALL_MEMBERSHIP_MARKER_FILE = 'call-membership-indexed';

/** Rows stamped per transaction while indexing one run's older rows. */
const STAMP_BATCH_SIZE = 500;

/**
 * A breath between batches: the sweep runs while the daemon is serving, and
 * better-sqlite3 is synchronous, so the event loop turns only between batches.
 */
const STAMP_BATCH_PAUSE_MS = 10;

/**
 * Writes and repairs `Item.inCall` — which call's card each row of a run is
 * drawn in (`utils/call-membership.ts`), the key a team run's transcript is
 * paged by.
 */
@Injectable()
export class ItemCallIndexService {
  private readonly logger = new Logger(ItemCallIndexService.name);

  /** Per run, the call starts and delegate declarations it holds, kept current as rows are written. */
  private readonly lookups = new Map<string, Promise<RunLookup>>();

  /** Whether each run asked about can hold calls — see {@link holdsCalls}. */
  private readonly runKinds = new Map<string, boolean>();

  /** Runs known to hold no unstamped row. Every row written from now on is stamped, so it stays true. */
  private readonly indexed = new Set<string>();

  private readonly indexing = new Map<string, Promise<void>>();

  /** Moves when every stamp is cleared; a stamping pass that spans one starts over. */
  private epoch = 0;

  /** Changes whenever every `inCall` stamp is cleared, so a reader holding rows knows to read them again. */
  get stampEpoch(): number {
    return this.epoch;
  }

  private readonly markerPath: string;

  constructor(
    private readonly itemDao: ItemDao,
    private readonly runDao: RunDao,
    private readonly em: EntityManager,
    /** Test seam only — nothing in the app passes it. */
    @Optional() markerPath?: string,
  ) {
    this.markerPath =
      markerPath ?? join(environment.userDataDir, CALL_MEMBERSHIP_MARKER_FILE);
  }

  /**
   * Whether a run can hold calls at all. Only a team's agents call one
   * another, so every row of a chat is in its own flow and a conversation read
   * of one is a read of the whole run — with nothing to index first. Kept per
   * run: what kind of run it is never changes.
   */
  async holdsCalls(runId: string): Promise<boolean> {
    const known = this.runKinds.get(runId);
    if (known !== undefined) {
      return known;
    }
    const run = await this.runDao.getById(runId, this.em.fork());
    if (run === null) {
      return false;
    }
    const holds = run.teamId !== null;
    this.runKinds.set(runId, holds);
    return holds;
  }

  /** Every call the run started, in order, from the lookup kept current as rows are written. */
  async callStartsOf(runId: string): Promise<CallStart[]> {
    return (await this.lookupFor(runId)).starts();
  }

  /** The `inCall` a row about to be written is stamped with. */
  async inCallOf(runId: string, row: CallMembershipRow): Promise<string> {
    const record = asRecord(row.payload);
    if (
      !CALL_MEMBERSHIP_SOURCE_KINDS.includes(row.kind) &&
      typeof record?.callId !== 'string'
    ) {
      return OUTSIDE_ANY_CALL;
    }
    const lookup = await this.lookupFor(runId);
    lookup.learn(row);
    return callMembershipOf(row, lookup);
  }

  /**
   * Stamp every row of one run written before the column existed. A
   * conversation read awaits this, since a row it has not stamped is invisible
   * to it; once a run is done it costs nothing.
   */
  ensureIndexed(runId: string): Promise<void> {
    if (this.indexed.has(runId)) {
      return Promise.resolve();
    }
    const running = this.indexing.get(runId);
    if (running) {
      return running;
    }
    const work = this.stampRun(runId).finally(() => {
      this.indexing.delete(runId);
    });
    this.indexing.set(runId, work);
    return work;
  }

  /**
   * The boot entry point: every team run, newest first, so the threads
   * opened next are ready soonest. Never throws; a run it misses is stamped
   * when it is first read.
   */
  async indexAllQuietly(): Promise<void> {
    try {
      const swept = await this.sweptVersion();
      if (swept === CALL_MEMBERSHIP_VERSION) {
        return;
      }
      // Stamps of another rule, or of a launch that never finished a sweep,
      // are cleared and redone. A read between the two answers from the rows
      // stamped by then — once, on the launch the rule changed.
      // Passes already running finish first. One that starts while the clear
      // is under way reads the epoch from before it, and starts over.
      await Promise.allSettled([...this.indexing.values()]);
      await this.itemDao.forgetInCalls(this.em.fork());
      this.epoch += 1;
      this.indexed.clear();
      const runs = await this.runDao.listTeamRuns('all', this.em.fork());
      let checked = 0;
      for (const run of runs) {
        if (this.indexed.has(run.id)) {
          continue;
        }
        await this.ensureIndexed(run.id);
        checked += 1;
      }
      if (checked > 0) {
        this.logger.log(`checked call membership for ${checked} team run(s)`);
      }
      await this.markSwept();
    } catch (err) {
      this.logger.warn(
        `call-membership sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async stampRun(runId: string): Promise<void> {
    for (;;) {
      const epoch = this.epoch;
      await this.stampOnce(runId);
      if (epoch === this.epoch) {
        this.indexed.add(runId);
        return;
      }
    }
  }

  private async stampOnce(runId: string): Promise<void> {
    const em = this.em.fork();
    if (!(await this.itemDao.hasUnstampedRow(runId, em))) {
      return;
    }
    // The run's starts and declarations are read whole, stamped rows included:
    // a run written across the upgrade holds both, and the rule reads them all.
    const lookup = await this.loadLookup(runId, em);
    let afterSeq = -1;
    for (;;) {
      const rows = await this.itemDao.unstampedRows(
        runId,
        afterSeq,
        STAMP_BATCH_SIZE,
        em,
      );
      if (rows.length === 0) {
        break;
      }
      // One UPDATE per distinct value: a batch is a few calls' rows.
      const byInCall = new Map<string, string[]>();
      for (const row of rows) {
        const inCall = callMembershipOf(
          {
            kind: row.kind,
            memberId: row.memberId,
            payload: parseJsonColumn(row.payload),
          },
          lookup,
        );
        const ids = byInCall.get(inCall);
        if (ids === undefined) {
          byInCall.set(inCall, [row.id]);
        } else {
          ids.push(row.id);
        }
      }
      await em.transactional(async (tx) => {
        for (const [inCall, ids] of byInCall) {
          await this.itemDao.rememberInCall(ids, inCall, tx as EntityManager);
        }
      });
      afterSeq = rows[rows.length - 1]!.seq;
      await pause();
    }
  }

  /** The rule version the last finished sweep ran under, or null when none finished. */
  private async sweptVersion(): Promise<number | null> {
    try {
      const version = Number.parseInt(
        await readFile(this.markerPath, 'utf8'),
        10,
      );
      return Number.isNaN(version) ? null : version;
    } catch {
      return null;
    }
  }

  /**
   * A failed write costs the next launch the whole sweep again — every stamp
   * cleared and redone — which is slow, not wrong.
   */
  private async markSwept(): Promise<void> {
    try {
      await writeFile(
        this.markerPath,
        `${CALL_MEMBERSHIP_VERSION}\n${new Date().toISOString()}\n`,
        'utf8',
      );
    } catch (err) {
      this.logger.warn(
        `could not record the call-membership sweep as done: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private lookupFor(runId: string): Promise<RunLookup> {
    const held = this.lookups.get(runId);
    if (held) {
      // Re-inserted so the cache drops the run written to least recently.
      this.lookups.delete(runId);
      this.lookups.set(runId, held);
      return held;
    }
    const loading = this.loadLookup(runId, this.em.fork());
    loading.catch(() => {
      this.lookups.delete(runId);
    });
    this.lookups.set(runId, loading);
    if (this.lookups.size > LOOKUP_CACHE_SIZE) {
      const oldest = this.lookups.keys().next().value;
      if (oldest !== undefined) {
        this.lookups.delete(oldest);
      }
    }
    return loading;
  }

  private async loadLookup(
    runId: string,
    em: EntityManager,
  ): Promise<RunLookup> {
    const rows = await this.itemDao.rowsOfKinds(
      runId,
      CALL_MEMBERSHIP_SOURCE_KINDS,
      undefined,
      em,
    );
    return callMembershipLookupOf(
      rows.map((row) => ({
        kind: row.kind,
        memberId: row.memberId,
        payload: parseJsonColumn(row.payload),
      })),
    );
  }
}

function pause(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, STAMP_BATCH_PAUSE_MS);
  });
}

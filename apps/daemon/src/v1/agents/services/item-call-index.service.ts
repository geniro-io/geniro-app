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

/** How long a read leaves a run whose re-stamp failed before it starts one again. */
const RESTAMP_RETRY_MS = 10 * 60_000;

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

  /** Team runs whose every older row was stamped again under this rule on this launch. */
  private readonly restamped = new Set<string>();

  private readonly restamping = new Map<string, Promise<void>>();

  /** Per run, how many times stamping it again changed a row's stamp on this launch. */
  private readonly epochs = new Map<string, number>();

  /** When each run's last re-stamp failed, so reads do not start one again at once. */
  private readonly restampFailedAt = new Map<string, number>();

  /** Whether the stamps on disk may be another rule's, read from the marker once per launch. */
  private ruleChange: Promise<boolean> | null = null;

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
   * Moves when a run's older rows were stamped again under a changed rule, so
   * a reader holding that run's rows knows to read them again.
   */
  stampEpochOf(runId: string): number {
    return this.epochs.get(runId) ?? 0;
  }

  /**
   * Stamp every row of one run written before the column existed. A
   * conversation read awaits this, since a row it has not stamped is invisible
   * to it; once a run is done it costs nothing.
   *
   * On a launch whose marker names another rule it also starts stamping the
   * run's older rows again, and does not wait for it: on a long-used profile
   * that is a read of every row of the run, tens of seconds for a large one on
   * a cold cache. Until it is done the run reads under the previous rule's
   * stamps, and {@link stampEpochOf} moves once it changed any.
   */
  ensureIndexed(runId: string): Promise<void> {
    void this.restampQuietly(runId);
    if (this.indexed.has(runId)) {
      return Promise.resolve();
    }
    const running = this.indexing.get(runId);
    if (running) {
      return running;
    }
    const work = this.stampOnce(runId)
      .then(() => {
        this.indexed.add(runId);
      })
      .finally(() => {
        this.indexing.delete(runId);
      });
    this.indexing.set(runId, work);
    return work;
  }

  /**
   * The boot entry point: on a launch whose marker names another rule, every
   * team run, newest first, so the threads opened next are ready soonest, one
   * run at a time. Never throws; the marker is written only once every team
   * run is done, so a launch that stops short is redone whole by the next.
   */
  async indexAllQuietly(): Promise<void> {
    try {
      if (!(await this.ruleChanged())) {
        return;
      }
      const runs = await this.runDao.listTeamRuns('all', this.em.fork());
      let failed = 0;
      for (const run of runs) {
        try {
          await this.ensureIndexed(run.id);
          await this.restampOf(run.id);
        } catch (err) {
          failed += 1;
          this.logger.warn(
            `run ${run.id}: could not stamp call membership again: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (runs.length > 0) {
        this.logger.log(
          `checked call membership for ${runs.length - failed} of ${runs.length} team run(s)`,
        );
      }
      if (failed > 0) {
        return;
      }
      await this.markSwept();
      this.ruleChange = Promise.resolve(false);
    } catch (err) {
      this.logger.warn(
        `call-membership sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async restampQuietly(runId: string): Promise<void> {
    if (this.restamped.has(runId) || this.restamping.has(runId)) {
      return;
    }
    const failedAt = this.restampFailedAt.get(runId);
    if (failedAt !== undefined && Date.now() - failedAt < RESTAMP_RETRY_MS) {
      return;
    }
    try {
      if ((await this.ruleChanged()) && (await this.holdsCalls(runId))) {
        await this.restampOf(runId);
      }
    } catch (err) {
      this.logger.warn(
        `run ${runId}: could not stamp call membership again: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private restampOf(runId: string): Promise<void> {
    if (this.restamped.has(runId)) {
      return Promise.resolve();
    }
    const running = this.restamping.get(runId);
    if (running) {
      return running;
    }
    const work = this.restamp(runId)
      .then(
        () => {
          this.restamped.add(runId);
          this.restampFailedAt.delete(runId);
        },
        (err: unknown) => {
          this.restampFailedAt.set(runId, Date.now());
          throw err;
        },
      )
      .finally(() => {
        this.restamping.delete(runId);
      });
    this.restamping.set(runId, work);
    return work;
  }

  private ruleChanged(): Promise<boolean> {
    this.ruleChange ??= this.sweptVersion().then(
      (swept) => swept !== CALL_MEMBERSHIP_VERSION,
    );
    return this.ruleChange;
  }

  /**
   * Stamp again, under this rule, every row of a run an older build or rule
   * stamped. Rows above the run's newest seq when it starts were stamped as
   * they were written, by this build. A run whose promoted columns are stamped
   * is placed from them: the rule reads no payload field but `callId` and `id`.
   * The lookup is the live one every written row teaches, so a row written
   * while the pass runs is placed as it was stamped. Any row changed, the
   * run's epoch moves, whether or not the pass ends.
   */
  private async restamp(runId: string): Promise<void> {
    const em = this.em.fork();
    const through = await this.itemDao.maxSeq(runId, em);
    const fromColumns = await this.itemDao.payloadRefsStamped(runId, em);
    const lookup = await this.lookupFor(runId);
    let after: { seq: number; id: string } | null = null;
    let changed = 0;
    try {
      for (;;) {
        const rows = await this.itemDao.inCallBatch(
          runId,
          after,
          through,
          STAMP_BATCH_SIZE,
          !fromColumns,
          em,
        );
        if (rows.length === 0) {
          return;
        }
        changed += await this.writeStamps(
          rows.map((row) => ({
            id: row.id,
            inCall: row.inCall,
            membership: {
              kind: row.kind,
              memberId: row.memberId,
              payload: fromColumns
                ? { callId: row.callId, id: row.payloadId }
                : parseJsonColumn(row.payload ?? ''),
            },
          })),
          lookup,
          em,
        );
        const last = rows[rows.length - 1]!;
        after = { seq: last.seq, id: last.id };
        await pause();
      }
    } finally {
      if (changed > 0) {
        this.epochs.set(runId, this.stampEpochOf(runId) + 1);
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
      await this.writeStamps(
        rows.map((row) => ({
          id: row.id,
          inCall: row.inCall,
          membership: {
            kind: row.kind,
            memberId: row.memberId,
            payload: parseJsonColumn(row.payload),
          },
        })),
        lookup,
        em,
      );
      afterSeq = rows[rows.length - 1]!.seq;
      await pause();
    }
  }

  /** Write each row's stamp under the rule, skipping a row that already carries it; answers how many it wrote. */
  private async writeStamps(
    rows: readonly {
      id: string;
      inCall: string | null;
      membership: CallMembershipRow;
    }[],
    lookup: RunLookup,
    em: EntityManager,
  ): Promise<number> {
    // One UPDATE per distinct value: a batch is a few calls' rows.
    const byInCall = new Map<string, string[]>();
    for (const row of rows) {
      const inCall = callMembershipOf(row.membership, lookup);
      if (inCall === row.inCall) {
        continue;
      }
      const ids = byInCall.get(inCall);
      if (ids === undefined) {
        byInCall.set(inCall, [row.id]);
      } else {
        ids.push(row.id);
      }
    }
    if (byInCall.size === 0) {
      return 0;
    }
    await em.transactional(async (tx) => {
      for (const [inCall, ids] of byInCall) {
        await this.itemDao.rememberInCall(ids, inCall, tx as EntityManager);
      }
    });
    return [...byInCall.values()].reduce((sum, ids) => sum + ids.length, 0);
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
   * A failed write costs the next launch the whole sweep again — every team
   * run stamped again — which is slow, not wrong.
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

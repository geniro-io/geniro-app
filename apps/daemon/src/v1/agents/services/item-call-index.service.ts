import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, Optional } from '@nestjs/common';

import { environment } from '../../../environments';
import type { Item } from '../../runs/entity/item.entity';
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

/** Rows read per batch while stamping one run's rows from their payloads. */
const STAMP_BATCH_SIZE = 500;

/**
 * Stamps written per transaction while stamping a run again. A stamp rewrites
 * the row's whole record, payload overflow included, so a batch is small.
 */
const RESTAMP_WRITE_BATCH = 50;

/**
 * The breath between batches, at least as long as the batch it follows,
 * within these bounds: the stamping runs while the daemon serves, and
 * better-sqlite3 is synchronous, so the event loop turns only between batches,
 * and back-to-back batches held every request behind them. A batch's commit
 * can carry a WAL checkpoint of most of a second.
 */
const STAMP_BATCH_PAUSE_MS = 10;
const STAMP_BATCH_PAUSE_MAX_MS = 1000;

/** How long to pause after a batch that held the event loop for `workedMs`. */
export function stampPauseAfter(workedMs: number): number {
  return Math.min(
    STAMP_BATCH_PAUSE_MAX_MS,
    Math.max(STAMP_BATCH_PAUSE_MS, Math.ceil(workedMs)),
  );
}

interface StampRow<K> {
  key: K;
  inCall: string | null;
  membership: CallMembershipRow;
}

interface Stamp<K> {
  key: K;
  inCall: string;
  /** The stamp the row carried when it was read. */
  was: string | null;
}

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
   * they were written, by this build. The lookup is the live one every written
   * row teaches, so a row written while the pass runs is placed as it was
   * stamped. Any row changed, the run's epoch moves, whether or not the pass
   * ends.
   */
  private async restamp(runId: string): Promise<void> {
    const em = this.em.fork();
    const through = await this.itemDao.maxSeq(runId, em);
    const lookup = await this.lookupFor(runId);
    const written = { count: 0 };
    try {
      if (await this.itemDao.payloadRefsStamped(runId, em)) {
        await this.restampFromColumns(runId, through, lookup, written, em);
      } else {
        await this.restampFromPayloads(runId, through, lookup, written, em);
      }
    } finally {
      if (written.count > 0) {
        this.epochs.set(runId, this.stampEpochOf(runId) + 1);
      }
    }
  }

  /**
   * A run whose promoted columns are stamped, one kind at a time, from the
   * indexes alone: the rule reads no payload field but `callId` and `id`.
   */
  private async restampFromColumns(
    runId: string,
    through: number,
    lookup: RunLookup,
    written: { count: number },
    em: EntityManager,
  ): Promise<void> {
    let since = performance.now();
    for (const kind of await this.itemDao.kindsOfRun(runId, em)) {
      const rows = await this.itemDao.inCallRowsOfKind(runId, kind, em);
      const stamps = restampsOf(
        rows
          .filter((row) => row.seq <= through)
          .map((row) => ({
            key: { rowid: row.rowid, seq: row.seq },
            inCall: row.inCall,
            membership: {
              kind,
              memberId: row.memberId,
              payload: { callId: row.callId, id: row.payloadId },
            },
          })),
        lookup,
      );
      since = await breathe(since);
      for (let at = 0; at < stamps.length; at += RESTAMP_WRITE_BATCH) {
        written.count += await writeStamps(
          stamps.slice(at, at + RESTAMP_WRITE_BATCH),
          em,
          (group, inCall, tx) =>
            this.itemDao.rememberInCallAt(
              runId,
              kind,
              inCall,
              group.map(({ key, was }) => ({ ...key, was })),
              tx,
            ),
        );
        since = await breathe(since);
      }
    }
  }

  private async restampFromPayloads(
    runId: string,
    through: number,
    lookup: RunLookup,
    written: { count: number },
    em: EntityManager,
  ): Promise<void> {
    let since = performance.now();
    let after: { seq: number; id: string } | null = null;
    for (;;) {
      const rows = await this.itemDao.inCallBatch(
        runId,
        after,
        through,
        STAMP_BATCH_SIZE,
        em,
      );
      if (rows.length === 0) {
        return;
      }
      written.count += await writeStamps(
        restampsOf(rows.map(payloadStampRow), lookup),
        em,
        byId(this.itemDao),
      );
      const last = rows[rows.length - 1]!;
      after = { seq: last.seq, id: last.id };
      since = await breathe(since);
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
    let since = performance.now();
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
      await writeStamps(
        restampsOf(rows.map(payloadStampRow), lookup),
        em,
        byId(this.itemDao),
      );
      afterSeq = rows[rows.length - 1]!.seq;
      since = await breathe(since);
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

function payloadStampRow(
  row: Pick<Item, 'id' | 'kind' | 'memberId' | 'inCall' | 'payload'>,
): StampRow<string> {
  return {
    key: row.id,
    inCall: row.inCall,
    membership: {
      kind: row.kind,
      memberId: row.memberId,
      payload: parseJsonColumn(row.payload),
    },
  };
}

/** The rows whose stamp the rule changes, each with the stamp it gets. */
function restampsOf<K>(
  rows: readonly StampRow<K>[],
  lookup: RunLookup,
): Stamp<K>[] {
  return rows.flatMap((row) => {
    const inCall = callMembershipOf(row.membership, lookup);
    return inCall === row.inCall
      ? []
      : [{ key: row.key, inCall, was: row.inCall }];
  });
}

/**
 * Write the stamps in one transaction, one write per distinct value (a batch
 * is a few calls' rows); answers how many rows the writes changed.
 */
async function writeStamps<K>(
  stamps: readonly Stamp<K>[],
  em: EntityManager,
  write: (
    stamps: Stamp<K>[],
    inCall: string,
    tx: EntityManager,
  ) => Promise<number>,
): Promise<number> {
  if (stamps.length === 0) {
    return 0;
  }
  const byInCall = new Map<string, Stamp<K>[]>();
  for (const stamp of stamps) {
    const group = byInCall.get(stamp.inCall);
    if (group === undefined) {
      byInCall.set(stamp.inCall, [stamp]);
    } else {
      group.push(stamp);
    }
  }
  return em.transactional(async (tx) => {
    let changed = 0;
    for (const [inCall, group] of byInCall) {
      changed += await write(group, inCall, tx as EntityManager);
    }
    return changed;
  });
}

function byId(
  itemDao: ItemDao,
): (
  stamps: Stamp<string>[],
  inCall: string,
  tx: EntityManager,
) => Promise<number> {
  return async (stamps, inCall, tx) => {
    await itemDao.rememberInCall(
      stamps.map(({ key }) => key),
      inCall,
      tx,
    );
    return stamps.length;
  };
}

/** Pause after the work done since `since`; answers when the next batch starts. */
async function breathe(since: number): Promise<number> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, stampPauseAfter(performance.now() - since));
  });
  return performance.now();
}

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { WallTurn } from '../../runs/entity/wall-turn.entity';
import { idBatches } from '../utils/id-batches';
import { positive } from '../utils/positive-figure';

/**
 * `wall_turns` as SQLite stores it — the shape its typed Kysely builder is
 * handed. Each column is typed off the entity property it stores, so a renamed
 * or retyped field fails the build; dates are the stored epoch milliseconds,
 * since value conversion is off.
 */
interface WallTurnDatabase {
  wall_turns: {
    run_id: WallTurn['runId'];
    seq: WallTurn['seq'];
    node_id: WallTurn['nodeId'];
    ms: WallTurn['ms'];
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
  };
}

/** Run ids per {@link WallTurnDao.chatSums} query. */
const CHAT_SUM_BATCH = 500;

/** Turns per {@link WallTurnDao.record} insert — 7 bound values each. */
const RECORD_BATCH = 500;

/** One measured turn to record — the fold's answer for one node or chat. */
export interface WallTurnRecord {
  seq: number;
  nodeId: string | null;
  ms: number;
}

/**
 * The ledger of turns measured by the wall clock (`WallTurn`). Insert-only:
 * a turn is recorded once, by its `(runId, seq)` key, and never updated.
 */
@Injectable()
export class WallTurnDao extends BaseDao<WallTurn> {
  constructor(em: EntityManager) {
    super(em, WallTurn);
  }

  /**
   * Record these turns, ignoring every one already recorded
   * (`INSERT … ON CONFLICT DO NOTHING`, one statement per
   * {@link RECORD_BATCH} turns). Each turn is its own row under its own key,
   * so any number of concurrent catch-ups land it exactly once, and a crash
   * at any point leaves only whole turns recorded — the next catch-up adds
   * the rest. A non-positive figure is not a measurement and is not written.
   */
  async record(
    runId: string,
    turns: readonly WallTurnRecord[],
    txEm?: EntityManager,
  ): Promise<void> {
    const measured = turns.filter((turn) => positive(turn.ms));
    const db = (txEm ?? this.em.fork()).getKysely<WallTurnDatabase>({
      convertValues: false,
    });
    const now = Date.now();
    for (let at = 0; at < measured.length; at += RECORD_BATCH) {
      await db
        .insertInto('wall_turns')
        .values(
          measured.slice(at, at + RECORD_BATCH).map((turn) => ({
            run_id: runId,
            seq: turn.seq,
            node_id: turn.nodeId,
            ms: Math.round(turn.ms),
            created_at: now,
            updated_at: now,
            deleted_at: null,
          })),
        )
        .onConflict((conflict) =>
          conflict.columns(['run_id', 'seq']).doNothing(),
        )
        .execute();
    }
  }

  /** The run's whole recorded wall time — every node's and a chat's alike. */
  async runSum(runId: string, txEm?: EntityManager): Promise<number> {
    const row = await (txEm ?? this.em.fork())
      .getKysely<WallTurnDatabase>({ convertValues: false })
      .selectFrom('wall_turns')
      .select((eb) => eb.fn.sum<number>('ms').as('ms'))
      .where('run_id', '=', runId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return Number(row?.ms ?? 0);
  }

  /** Each workflow node's recorded wall time in this run, by node id. */
  async nodeSums(
    runId: string,
    txEm?: EntityManager,
  ): Promise<Map<string, number>> {
    const rows = await (txEm ?? this.em.fork())
      .getKysely<WallTurnDatabase>({ convertValues: false })
      .selectFrom('wall_turns')
      .select((eb) => ['node_id', eb.fn.sum<number>('ms').as('ms')])
      .where('run_id', '=', runId)
      .where('node_id', 'is not', null)
      .where('deleted_at', 'is', null)
      .groupBy('node_id')
      .execute();
    const out = new Map<string, number>();
    for (const row of rows) {
      if (row.node_id !== null) {
        out.set(row.node_id, Number(row.ms));
      }
    }
    return out;
  }

  /**
   * Each of these runs' whole recorded wall time ({@link runSum} for many), by run id; a
   * run with no measured turn is absent.
   */
  async runSums(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const db = (txEm ?? this.em.fork()).getKysely<WallTurnDatabase>({
      convertValues: false,
    });
    for (const batch of idBatches(runIds)) {
      const rows = await db
        .selectFrom('wall_turns')
        .select((eb) => ['run_id', eb.fn.sum<number>('ms').as('ms')])
        .where('run_id', 'in', batch)
        .where('deleted_at', 'is', null)
        .groupBy('run_id')
        .execute();
      for (const row of rows) {
        out.set(row.run_id, Number(row.ms));
      }
    }
    return out;
  }

  /**
   * Each of these runs' 1:1-chat wall time (the rows with no node), by run id
   * — one query, for a listing of many.
   */
  async chatSums(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const db = (txEm ?? this.em.fork()).getKysely<WallTurnDatabase>({
      convertValues: false,
    });
    // Batched so a long listing stays far inside SQLite's bound-variable cap.
    for (let at = 0; at < runIds.length; at += CHAT_SUM_BATCH) {
      const rows = await db
        .selectFrom('wall_turns')
        .select((eb) => ['run_id', eb.fn.sum<number>('ms').as('ms')])
        .where('run_id', 'in', runIds.slice(at, at + CHAT_SUM_BATCH))
        .where('node_id', 'is', null)
        .where('deleted_at', 'is', null)
        .groupBy('run_id')
        .execute();
      for (const row of rows) {
        out.set(row.run_id, Number(row.ms));
      }
    }
    return out;
  }
}

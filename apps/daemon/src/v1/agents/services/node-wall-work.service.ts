import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, Optional } from '@nestjs/common';

import { environment } from '../../../environments';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { wallMeasuredTurns } from '../utils/wall-worked';

/**
 * Bumped to have the boot sweep run again. A bump re-runs catch-up and nothing
 * else: it measures only turns ABOVE each node's mark, so it cannot re-measure
 * a turn already added under an older rule — that would need the added figure
 * subtracted, and the ledger keeps a sum and a mark, not per-turn figures.
 * A rule change that must re-measure history is not supported by this ledger.
 */
export const WALL_WORK_VERSION = 1;

/**
 * Retires the boot sweep once it has run to the end — a file in the userData
 * dir holding {@link WALL_WORK_VERSION}, on `ItemCallIndexService`'s pattern.
 * Only the sweep retires: every turn settled since is caught up live.
 */
const MARKER_FILE = 'wall-work-measured';

/**
 * How many times one catch-up re-folds after losing the compare-and-set. Each
 * loss means another catch-up ADDED turns, so a few rounds settle it; a node
 * still contended after them is left for its next turn or launch, which will
 * find every unmeasured turn above the mark.
 */
const MAX_CATCH_UP_ATTEMPTS = 5;

/**
 * The wall-clock ledger of a workflow node's worked time: the turns its CLI did
 * not time itself (every ACP agent), measured by the daemon from the node's own
 * durable rows (`utils/wall-worked.ts`) and added to `NodeState.workedMs`
 * beside the CLI-timed turns the executor adds directly.
 *
 * Why the daemon measures them: the renderer used to fold them from the rows it
 * had LOADED, so a cursor node's `worked` figure moved as the user scrolled.
 * Measured here from every row, it is the same figure however much is loaded.
 */
@Injectable()
export class NodeWallWorkService {
  private readonly logger = new Logger(NodeWallWorkService.name);

  private readonly markerPath: string;

  constructor(
    private readonly itemDao: ItemDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly runDao: RunDao,
    private readonly em: EntityManager,
    /** Test seam only — nothing in the app passes it. */
    @Optional() markerPath?: string,
  ) {
    this.markerPath = markerPath ?? join(environment.userDataDir, MARKER_FILE);
  }

  /**
   * Add every settled wall-measured turn of this node above its mark, once.
   *
   * Idempotent and safe to run concurrently with itself: the sum and the new
   * mark are written in one compare-and-set on the mark this call read
   * (`NodeStateDao.addWallWork`), so of two callers that folded the same
   * turns only one adds them, and the other re-folds above the new mark.
   * Throws on a database failure; the callers decide what that costs.
   */
  async catchUp(
    runId: string,
    nodeId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_CATCH_UP_ATTEMPTS; attempt += 1) {
      const mark = await this.nodeStateDao.wallMeasuredThroughSeq(
        runId,
        nodeId,
        txEm,
      );
      if (mark === undefined) {
        return;
      }
      const turns = wallMeasuredTurns(
        await this.itemDao.nodeWallClockRows(runId, nodeId, txEm),
      ).filter((turn) => mark === null || turn.seq > mark);
      if (turns.length === 0) {
        return;
      }
      const addMs = turns.reduce((total, turn) => total + turn.ms, 0);
      const throughSeq = Math.max(...turns.map((turn) => turn.seq));
      if (
        await this.nodeStateDao.addWallWork(
          runId,
          nodeId,
          mark,
          throughSeq,
          addMs,
          txEm,
        )
      ) {
        return;
      }
    }
    this.logger.warn(
      `wall work for ${runId}/${nodeId} still contended after ${MAX_CATCH_UP_ATTEMPTS} attempts — left for the next catch-up`,
    );
  }

  /**
   * The boot entry point: every node of every workflow run, caught up once —
   * the runs whose cursor turns were settled before this ledger existed.
   * Never throws. A run that fails is logged and skipped, and keeps the marker
   * unwritten so the next launch tries again; the mark makes that re-run add
   * nothing twice.
   */
  async sweepAllQuietly(): Promise<void> {
    try {
      if ((await this.sweptVersion()) === WALL_WORK_VERSION) {
        return;
      }
      const runs = await this.runDao.listWorkflowRuns('all', this.em.fork());
      let failed = 0;
      for (const run of runs) {
        try {
          const em = this.em.fork();
          for (const node of await this.nodeStateDao.listByRun(run.id, em)) {
            await this.catchUp(run.id, node.nodeId, em);
          }
        } catch (err) {
          failed += 1;
          this.logger.warn(
            `wall work for workflow run ${run.id} not measured: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (failed === 0) {
        await this.markSwept();
      }
    } catch (err) {
      this.logger.warn(
        `wall-work sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** The version the last finished sweep ran under, or null when none finished. */
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

  /** A failed write costs the next launch another sweep, which adds nothing twice. */
  private async markSwept(): Promise<void> {
    try {
      await writeFile(
        this.markerPath,
        `${WALL_WORK_VERSION}\n${new Date().toISOString()}\n`,
        'utf8',
      );
    } catch (err) {
      this.logger.warn(
        `could not record the wall-work sweep as done: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

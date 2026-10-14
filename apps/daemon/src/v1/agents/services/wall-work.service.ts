import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, Optional } from '@nestjs/common';

import { environment } from '../../../environments';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { WallTurnDao } from '../dao/wall-turn.dao';
import { wallMeasuredTurns } from '../utils/wall-worked';

/**
 * Bumped to have the boot sweep run again. A bump re-runs catch-up over every
 * run and nothing else: it records the turns not yet recorded, and leaves the
 * rows already recorded as they are (rows are never updated). A rule change
 * that must re-measure recorded turns has to delete them first.
 */
export const WALL_WORK_VERSION = 2;

/**
 * Retires the boot sweep once it has run to the end — a file in the userData
 * dir holding {@link WALL_WORK_VERSION}, on `ItemCallIndexService`'s pattern.
 * Only the sweep retires: every turn settled since is caught up live, and any
 * later catch-up of the same agent records whatever an earlier one missed.
 */
const MARKER_FILE = 'wall-work-measured';

/**
 * The wall-clock ledger of agents' worked time: the turns a CLI did not time
 * itself (every ACP agent), measured by the daemon from the agent's own
 * durable rows (`utils/wall-worked.ts`) and recorded one row per turn in
 * `wall_turns` (`WallTurnDao`). The figure served for a node or a chat is its
 * CLI-reported total plus that ledger's sum (`servedWorkedMs`).
 *
 * Why the daemon measures them: the renderer folded them from the rows it had
 * LOADED, so a cursor agent's `worked` figure moved as the user scrolled.
 * Measured here from every row, it is the same however much is loaded.
 *
 * A catch-up records EVERY measured turn of its agent and lets the key ignore
 * the ones already there, rather than resuming from a high-water mark: a turn
 * whose row became durable after a later turn was measured (two writers
 * reserve seqs from one allocator) is then simply recorded by the next
 * catch-up, where a mark had already moved past it.
 */
@Injectable()
export class WallWorkService {
  private readonly logger = new Logger(WallWorkService.name);

  private readonly markerPath: string;

  constructor(
    private readonly itemDao: ItemDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly runDao: RunDao,
    private readonly wallTurns: WallTurnDao,
    private readonly em: EntityManager,
    /** Test seam only — nothing in the app passes it. */
    @Optional() markerPath?: string,
  ) {
    this.markerPath = markerPath ?? join(environment.userDataDir, MARKER_FILE);
  }

  /**
   * Record every settled wall-measured turn of one workflow node. Idempotent
   * and safe beside any concurrent catch-up of the same node. Throws on a
   * database failure; the callers decide what that costs.
   */
  async catchUpNode(
    runId: string,
    nodeId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    const rows = await this.itemDao.nodeWallClockRows(runId, nodeId, txEm);
    await this.wallTurns.record(runId, wallMeasuredTurns(rows, 'nodes'), txEm);
  }

  /** {@link catchUpNode} for a 1:1 chat's agent (its rows with no node). */
  async catchUpChat(runId: string, txEm?: EntityManager): Promise<void> {
    const rows = await this.itemDao.chatWallClockRows(runId, txEm);
    await this.wallTurns.record(runId, wallMeasuredTurns(rows, 'chat'), txEm);
  }

  /**
   * The boot entry point: every agent of every run caught up once — the turns
   * settled before this ledger existed. Never throws. A run that fails is
   * logged and skipped, and keeps the marker unwritten so the next launch tries
   * again; the ledger's key makes that re-run record nothing twice.
   */
  async sweepAllQuietly(): Promise<void> {
    try {
      if ((await this.sweptVersion()) === WALL_WORK_VERSION) {
        return;
      }
      const workflows = await this.runDao.listWorkflowRuns(
        'all',
        this.em.fork(),
      );
      const chats = await this.runDao.listChatRunIds(this.em.fork());
      let failed = 0;
      const each = async (runId: string, work: () => Promise<void>) => {
        try {
          await work();
        } catch (err) {
          failed += 1;
          this.logger.warn(
            `wall work for run ${runId} not measured: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      };
      for (const run of workflows) {
        await each(run.id, async () => {
          const em = this.em.fork();
          for (const node of await this.nodeStateDao.listByRun(run.id, em)) {
            await this.catchUpNode(run.id, node.nodeId, em);
          }
        });
      }
      for (const runId of chats) {
        await each(runId, () => this.catchUpChat(runId, this.em.fork()));
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

  /** A failed write costs the next launch another sweep, which records nothing twice. */
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

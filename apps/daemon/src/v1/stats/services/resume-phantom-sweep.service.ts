import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, Optional } from '@nestjs/common';

import { environment } from '../../../environments';
import { SINGLE_AGENT_NODE } from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { nodeSessionTargets } from '../../agents/utils/node-session-targets';
import { UsageEventDao } from '../dao/usage-event.dao';
import type { UsageEvent } from '../entity/usage-event.entity';
import {
  billedJustBefore,
  correctedTotalCost,
  looksLikeResumePhantom,
  restoredTotalMatch,
} from '../utils/resume-phantom';

/**
 * Bumped to have the sweep run again on every profile — only for a rule that
 * proves MORE rows; a row it already restated no longer matches a total.
 */
export const RESUME_PHANTOM_SWEEP_VERSION = 1;

/** Retires the sweep once it has run to the end — see `WallWorkService`. */
const MARKER_FILE = 'resume-phantoms-removed';

/** What one pass did: rows deleted, and rows restated to their own share. */
export interface ResumePhantomSweepResult {
  removed: number;
  restated: number;
}

/**
 * Takes back the spend a resumed claude session's opening line billed a second
 * time, recorded before the ledger read the restored total at the new
 * process's `init`: the line was billed the whole restored total, or the gap
 * between an older line and the one its predecessor wrote as it exited.
 *
 * Only what is proven goes. The row must have the phantom's shape and a cost
 * that is, to the bit, a recorded total of one of its node's sessions, or a
 * gap between two:
 * - on a node that held ONE conversation, a TOTAL is restated to that total
 *   less what the node's turns just before it billed, as far as they fit
 *   inside it (`correctedTotalCost`) — the rest is spend the replaced process
 *   made after its last result, which no other row holds — and left alone
 *   when nothing was billed before it;
 * - otherwise — a gap, or a total on a node that held several conversations,
 *   whose turns the ledger cannot tell apart — the row goes only when the
 *   node's turns just before it add up to it exactly (`billedJustBefore`), and
 *   is left alone when they do not.
 * A row whose run, node, session or transcript cannot be found is left alone;
 * a transcript that exists but cannot be read fails its row, and the pass is
 * not marked done, so the next launch checks it again. A row restated to zero
 * is deleted.
 *
 * The one write into `v1/agents`' rows from this module: the turn's transcript
 * row keeps its figures but carries the restated cost, which is what the run's
 * own readouts (waterfall, chat totals) sum. It is written before the ledger
 * row, so an interrupted pass is finished by the next launch.
 *
 * Runs behind the boot, started by `UsageBackfillService` once its turn
 * backfill is done, and once per profile (a versioned marker file): every
 * candidate costs whole-transcript reads, and the rows it cannot prove would
 * otherwise be re-read on every launch. A deleted turn's zeroed row can come
 * back as a $0 ledger row through that backfill's overlap window — it costs
 * nothing.
 */
@Injectable()
export class ResumePhantomSweepService {
  private readonly logger = new Logger(ResumePhantomSweepService.name);
  private readonly markerPath: string;

  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    private readonly runDao: RunDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly usageDao: UsageEventDao,
    private readonly adapters: AgentAdapterRegistry,
    /** Test seam only — nothing in the app passes it. */
    @Optional() markerPath?: string,
  ) {
    this.markerPath = markerPath ?? join(environment.userDataDir, MARKER_FILE);
  }

  /** {@link sweep}, logged rather than thrown. */
  async sweepQuietly(): Promise<void> {
    try {
      await this.sweep();
    } catch (err) {
      this.logger.warn(
        `resume phantom sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** One pass, a no-op once a pass has run to the end under this version. */
  async sweep(): Promise<ResumePhantomSweepResult> {
    const result: ResumePhantomSweepResult = { removed: 0, restated: 0 };
    if ((await this.sweptVersion()) === RESUME_PHANTOM_SWEEP_VERSION) {
      return result;
    }
    const em = this.em.fork();
    // One read per conversation per pass: a node's rows share its sessions.
    const totalsOf = new Map<string, Promise<number[]>>();
    let failed = 0;
    for (const row of await this.usageDao.zeroTurnCostedRows(em)) {
      if (!looksLikeResumePhantom(row)) {
        continue;
      }
      try {
        const costUsd = await this.provenCost(row, em, totalsOf);
        if (costUsd === null) {
          continue;
        }
        await this.itemDao.restateTurnCost(row.runId, row.seq, costUsd, em);
        if (costUsd === 0) {
          await this.usageDao.deleteTurn(row.runId, row.seq, em);
          result.removed += 1;
        } else {
          await this.usageDao.restateTurnCost(row.runId, row.seq, costUsd, em);
          result.restated += 1;
        }
      } catch (err) {
        failed += 1;
        this.logger.warn(
          `resume phantom check for run ${row.runId} seq ${row.seq} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (result.removed + result.restated > 0) {
      this.logger.log(
        `took back a resumed session's earlier spend from ${result.removed} removed and ${result.restated} restated turn(s)`,
      );
    }
    if (failed === 0) {
      await this.markSwept();
    }
    return result;
  }

  /** The cost a phantom should carry, or null when it is not proven one. */
  private async provenCost(
    row: UsageEvent,
    em: EntityManager,
    totalsOf: Map<string, Promise<number[]>>,
  ): Promise<number | null> {
    const costUsd = row.costUsd;
    if (costUsd === null) {
      return null;
    }
    const [run, state] = await Promise.all([
      this.runDao.getOne({ id: row.runId }, undefined, em),
      this.nodeStateDao.getOne(
        { runId: row.runId, nodeId: row.nodeId ?? SINGLE_AGENT_NODE },
        undefined,
        em,
      ),
    ]);
    if (run === null || state === null) {
      return null;
    }
    let match: 'total' | 'gap' | null = null;
    const targets = nodeSessionTargets(run, state);
    for (const target of targets) {
      const key = JSON.stringify([
        target.agentKind,
        target.configDir,
        target.sessionId,
      ]);
      let totals = totalsOf.get(key);
      if (totals === undefined) {
        totals =
          this.adapters.all().get(target.agentKind)?.readSessionCostTotals({
            sessionId: target.sessionId,
            configDir: target.configDir,
          }) ?? Promise.resolve([]);
        totalsOf.set(key, totals);
      }
      const found = restoredTotalMatch(costUsd, await totals);
      if (found === 'total') {
        match = found;
        break;
      }
      match ??= found;
    }
    if (match === null) {
      return null;
    }
    const before = await this.usageDao.costsBefore(
      row.runId,
      row.nodeId,
      row.seq,
      em,
    );
    // Only a node that ever held ONE conversation can say which of its turns
    // were that session's: with several, a share is a guess, and only an exact
    // repeat of the turns just before the row is proven.
    if (
      match === 'total' &&
      new Set(targets.map((target) => target.sessionId)).size === 1
    ) {
      return correctedTotalCost(costUsd, before);
    }
    return billedJustBefore(costUsd, before) ? 0 : null;
  }

  /** The version the last finished pass ran under, or null when none finished. */
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

  /** A failed write costs the next launch another pass, which removes nothing twice. */
  private async markSwept(): Promise<void> {
    try {
      await writeFile(
        this.markerPath,
        `${RESUME_PHANTOM_SWEEP_VERSION}\n${new Date().toISOString()}\n`,
        'utf8',
      );
    } catch (err) {
      this.logger.warn(
        `could not record the resume phantom sweep as done: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

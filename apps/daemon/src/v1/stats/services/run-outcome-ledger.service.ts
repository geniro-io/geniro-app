import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import type { RunItemEvent } from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { RunOutcomeHistoryService } from '../../agents/services/run-outcome-history.service';
import { parseJsonColumn } from '../../agents/utils/json-util';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import type { RunOutcomeLedgerRow } from '../stats.types';
import {
  ledgerRowOf,
  newestOutcomes,
  withHistory,
} from '../utils/run-outcome-ledger';

/**
 * Copies every pull request's recorded outcome (`run_outcome` items, written by
 * `record_outcome`) into the `usage_activity` ledger, which outlives the run — what a
 * per-workflow-version outcome fold reads. It OBSERVES the bus, like
 * `UsageActivityRecorderService`: the agents module writes the row and cannot depend on
 * this module.
 *
 * Each copy carries what the run's whole outcome history says about the pull request
 * (`RunOutcomeHistoryService`), read when the copy is made, so it survives the run too.
 * The live copy is fire-and-forget, so two outcomes of one pull request can land out of
 * order; the upsert only ever moves a row forward (`sourceSeq`). A copy a crash or a
 * failed write lost, or one made before the history was counted, is made at the next
 * launch by the sweep, behind the boot.
 */
@Injectable()
export class RunOutcomeLedgerService implements OnModuleInit {
  private readonly logger = new Logger(RunOutcomeLedgerService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly bus: AgentEventBus,
    private readonly itemDao: ItemDao,
    private readonly activityDao: UsageActivityDao,
    private readonly history: RunOutcomeHistoryService,
  ) {}

  onModuleInit(): void {
    this.bus.all().subscribe((event) => {
      if (event.item.kind === 'run_outcome') {
        void this.recordLive(event);
      }
    });
    // It reads every outcome row of the profile, and nothing needs it before the
    // window does.
    void this.sweepQuietly();
  }

  /**
   * Write every outcome the ledger lacks, holds an older copy of, or holds without its
   * history figures; returns how many rows it wrote. The ledger's copies are read once,
   * and each run's history once, so a launch with nothing to do writes nothing.
   */
  async sweep(): Promise<number> {
    const em = this.em.fork();
    const rows: RunOutcomeLedgerRow[] = [];
    for (const item of await this.itemDao.runOutcomeRows(em)) {
      const row = ledgerRowOf({
        ...item,
        payload: parseJsonColumn(item.payload),
      });
      if (row !== null) {
        rows.push(row);
      }
    }
    const recorded = await this.activityDao.runOutcomeCopies(em);
    const owed = new Map<string, RunOutcomeLedgerRow[]>();
    for (const [key, row] of newestOutcomes(rows)) {
      const copy = recorded.get(key);
      if (
        copy === undefined ||
        copy.sourceSeq < row.sourceSeq ||
        !copy.counted
      ) {
        const runRows = owed.get(row.runId) ?? [];
        runRows.push(row);
        owed.set(row.runId, runRows);
      }
    }
    let written = 0;
    for (const [runId, runRows] of owed) {
      const { pullRequests } = await this.history.read(runId, undefined, em);
      for (const row of runRows) {
        await this.activityDao.upsertRunOutcome(
          withHistory(row, pullRequests),
          em,
        );
        written += 1;
      }
    }
    return written;
  }

  private async recordLive(event: RunItemEvent): Promise<void> {
    const row = ledgerRowOf({
      runId: event.runId,
      seq: event.item.seq,
      payload: event.item.payload,
      createdAt: new Date(event.item.createdAt),
    });
    if (row === null) {
      this.logger.warn(
        `run ${event.runId} outcome row ${event.item.seq} did not read as an outcome; not copied to the ledger`,
      );
      return;
    }
    try {
      await this.activityDao.upsertRunOutcome(
        withHistory(row, (await this.history.read(event.runId)).pullRequests),
      );
    } catch (err) {
      this.logger.warn(
        `could not copy run ${event.runId} outcome row ${event.item.seq} to the ledger: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async sweepQuietly(): Promise<void> {
    try {
      const written = await this.sweep();
      if (written > 0) {
        this.logger.log(
          `copied ${written} pull request outcomes to the ledger`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `outcome ledger sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

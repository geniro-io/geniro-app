import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import type { InterruptCause } from '../../../utils/stop-cause';
import { RunDao } from '../dao/run.dao';
import { ActionOutcomeSweep } from './action-outcome-sweep.service';
import { ChatService } from './chat.service';
import { MonitorOutcomeSweep } from './monitor-outcome-sweep.service';

/**
 * The boot's close of what a previous daemon left open in-process — background
 * sub-agents, detached commands, command actions and monitors, in that order —
 * before listen, so no turn of this launch can race it.
 *
 * Only the runs written to since this last found them closed are read
 * (`Run.reconciledThroughSeq`): nothing can be left open in rows it already
 * read. A run it could not close durably — a reconcile that failed, or a chat
 * monitor whose end waits on a delivery after listen — keeps its old mark and
 * is read again next launch.
 */
@Injectable()
export class StrandedWorkReconcileService {
  private readonly logger = new Logger(StrandedWorkReconcileService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly chats: ChatService,
    private readonly actions: ActionOutcomeSweep,
    private readonly monitors: MonitorOutcomeSweep,
  ) {}

  async reconcile(cause: InterruptCause): Promise<void> {
    let due: string[];
    try {
      due = (await this.runDao.reconcileMarks(this.em.fork()))
        .filter(
          ({ newestSeq, reconciledThroughSeq }) =>
            reconciledThroughSeq === null || newestSeq > reconciledThroughSeq,
        )
        .map(({ runId }) => runId);
    } catch (err: unknown) {
      this.logger.error(
        `could not list the runs to reconcile on boot: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (due.length === 0) {
      return;
    }
    const unsettled = new Set([
      ...(await this.chats.reconcileStrandedDelegates(due)),
      ...(await this.chats.reconcileStrandedShells(due)),
      ...(await this.actions.sweep(due)),
      ...(await this.monitors.sweep(cause, due)),
    ]);
    const settled = new Set(due.filter((runId) => !unsettled.has(runId)));
    try {
      const marks = (await this.runDao.reconcileMarks(this.em.fork())).filter(
        ({ runId }) => settled.has(runId),
      );
      await this.em.fork().transactional(async (tx) => {
        for (const { runId, newestSeq } of marks) {
          await this.runDao.markReconciledThrough(runId, newestSeq, tx);
        }
      });
    } catch (err: unknown) {
      this.logger.error(
        `could not record the runs reconciled on boot: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

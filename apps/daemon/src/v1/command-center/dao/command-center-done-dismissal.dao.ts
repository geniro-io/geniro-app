import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { CommandCenterDoneDismissal } from '../entity/command-center-done-dismissal.entity';

/** `command_center_done_dismissals` — how far each thread's Done cards were dismissed. */
@Injectable()
export class CommandCenterDoneDismissalDao extends BaseDao<CommandCenterDoneDismissal> {
  constructor(em: EntityManager) {
    super(em, CommandCenterDoneDismissal);
  }

  list(managerRunId: string): Promise<CommandCenterDoneDismissal[]> {
    return this.getRepo(this.em.fork()).find(
      { managerRunId },
      { orderBy: { runId: 'asc' }, disableIdentityMap: true },
    );
  }

  /** False when the thread was already dismissed through `seq` or later, at the same finish. */
  async dismiss(
    managerRunId: string,
    runId: string,
    seq: number,
    finishKey: string | null,
    at: Date,
  ): Promise<boolean> {
    const em = this.em.fork();
    const repo = this.getRepo(em);
    const known = await repo.findOne({ managerRunId, runId });
    if (known === null) {
      repo.create(
        { managerRunId, runId, throughSeq: seq, finishKey, dismissedAt: at },
        { partial: true },
      );
      await em.flush();
      return true;
    }
    const throughSeq = Math.max(known.throughSeq, seq);
    if (throughSeq === known.throughSeq && known.finishKey === finishKey) {
      return false;
    }
    await repo.nativeUpdate(
      { id: known.id },
      { throughSeq, finishKey, dismissedAt: at },
    );
    return true;
  }

  async deleteOf(managerRunId: string): Promise<void> {
    await this.getRepo(this.em.fork()).nativeDelete({ managerRunId });
  }
}

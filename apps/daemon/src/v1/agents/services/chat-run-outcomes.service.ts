import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import type { RunOutcomesWire } from '../chat.types';
import { RunDao } from '../dao/run.dao';
import { RunOutcomeHistoryService } from './run-outcome-history.service';

/**
 * Every outcome a run recorded, per pull request — what the agents panel's
 * history lists. A daemon route on {@link ChatTeamNotesService}'s reason: the
 * renderer holds one page of the transcript, and the panel lists the whole set.
 */
@Injectable()
export class ChatRunOutcomesService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly history: RunOutcomeHistoryService,
  ) {}

  async read(runId: string): Promise<RunOutcomesWire> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (run === null) {
      throw new NotFoundException('RUN_NOT_FOUND', 'no such chat');
    }
    const { pullRequests } = await this.history.read(runId, undefined, em);
    return { pullRequests };
  }
}

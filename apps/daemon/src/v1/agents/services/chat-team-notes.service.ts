import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import type { RunTeamNotesWire } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { foldTeamNotes } from '../utils/team-note-fold';

/**
 * Every team note one run holds, newest first, with each supersede pair
 * folded in — what the agents panel lists. A daemon route on
 * {@link ChatArtifactsService}'s reason: the renderer holds one page of the
 * transcript, and the panel lists the whole set. Uncapped like that route:
 * the run's own cap (`TEAM_NOTES_PER_RUN`) bounds it.
 */
@Injectable()
export class ChatTeamNotesService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
  ) {}

  async read(runId: string): Promise<RunTeamNotesWire> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (run === null) {
      throw new NotFoundException('RUN_NOT_FOUND', 'no such chat');
    }
    const notes = foldTeamNotes(await this.itemDao.teamNoteRows(runId, em));
    return { notes: notes.reverse() };
  }
}

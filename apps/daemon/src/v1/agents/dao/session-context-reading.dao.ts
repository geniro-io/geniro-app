import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { SessionContextReading } from '../../runs/entity/session-context-reading.entity';

@Injectable()
export class SessionContextReadingDao extends BaseDao<SessionContextReading> {
  constructor(em: EntityManager) {
    super(em, SessionContextReading);
  }

  async save(
    reading: SessionContextReading,
    em: EntityManager = this.em.fork(),
  ): Promise<void> {
    await em.upsert(SessionContextReading, reading);
  }

  async listOfRuns(
    runIds: readonly string[],
    em: EntityManager = this.em.fork(),
  ): Promise<SessionContextReading[]> {
    if (runIds.length === 0) {
      return [];
    }
    return em.find(
      SessionContextReading,
      { runId: { $in: [...runIds] } },
      { orderBy: { createdAt: 'desc' } },
    );
  }
}

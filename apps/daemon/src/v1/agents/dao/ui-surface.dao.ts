import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { UiSurface } from '../../runs/entity/ui-surface.entity';

@Injectable()
export class UiSurfaceDao extends BaseDao<UiSurface> {
  constructor(em: EntityManager) {
    super(em, UiSurface);
  }

  async find(
    runId: string,
    surfaceId: string,
    em: EntityManager = this.em.fork(),
  ): Promise<UiSurface | null> {
    return em.findOne(UiSurface, { runId, surfaceId });
  }

  async listOfRun(
    runId: string,
    em: EntityManager = this.em.fork(),
  ): Promise<UiSurface[]> {
    return em.find(UiSurface, { runId }, { orderBy: { firstSeq: 'asc' } });
  }

  async countLive(
    runId: string,
    em: EntityManager = this.em.fork(),
  ): Promise<number> {
    return em.count(UiSurface, { runId, removedAt: null });
  }

  async save(surface: UiSurface, em: EntityManager): Promise<void> {
    em.persist(surface);
    await em.flush();
  }
}

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { ArtifactShare } from '../entity/artifact-share.entity';

@Injectable()
export class ArtifactShareDao extends BaseDao<ArtifactShare> {
  constructor(em: EntityManager) {
    super(em, ArtifactShare);
  }

  async findByArtifact(
    runId: string,
    artifactId: string,
  ): Promise<ArtifactShare | null> {
    return this.getOne({ runId, artifactId });
  }

  /** Newest first; every run's when `runId` is absent. */
  async list(runId?: string): Promise<ArtifactShare[]> {
    return this.getAll(runId === undefined ? {} : { runId }, {
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * A revoked share is GONE, soft-deleted rows included: the (runId,
   * artifactId) unique key would otherwise refuse sharing the page again.
   */
  async remove(id: string): Promise<void> {
    await this.hardDeleteIncludingSoftDeleted({ id });
  }
}

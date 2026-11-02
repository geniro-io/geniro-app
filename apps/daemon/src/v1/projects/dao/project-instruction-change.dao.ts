import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { ProjectInstructionChange } from '../entity/project-instruction-change.entity';
import type {
  ProjectInstructionChangeRecord,
  ProjectInstructionField,
} from '../projects.types';

function idsOf(json: string | null): string[] {
  if (json === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}

function recordOf(
  row: ProjectInstructionChange,
): ProjectInstructionChangeRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    changedAt: row.changedAt,
    field: row.field,
    source: row.source,
    previous: row.previous,
    next: row.next,
    recommendationIds: idsOf(row.recommendationIds),
    chatRunId: row.chatRunId,
    cardSeq: row.cardSeq,
  };
}

/** The change log of the projects' description and instructions (see the entity). */
@Injectable()
export class ProjectInstructionChangeDao extends BaseDao<ProjectInstructionChange> {
  constructor(em: EntityManager) {
    super(em, ProjectInstructionChange);
  }

  /** The newest logged change to one field of one project. */
  async newestOf(
    projectId: string,
    field: ProjectInstructionField,
    txEm?: EntityManager,
  ): Promise<ProjectInstructionChange | null> {
    const [row] = await this.getAll(
      { projectId, field },
      { orderBy: { changedAt: 'desc' }, limit: 1 },
      txEm,
    );
    return row ?? null;
  }

  /** A project's newest `limit` changes, newest first. */
  async recentFor(
    projectId: string,
    limit: number,
    txEm?: EntityManager,
  ): Promise<ProjectInstructionChangeRecord[]> {
    const rows = await this.getAll(
      { projectId },
      { orderBy: { changedAt: 'desc' }, limit },
      txEm,
    );
    return rows.map(recordOf);
  }

  /** Serialize the recommendation ids an analysis carried out. */
  static idsJson(ids: readonly string[]): string | null {
    return ids.length === 0 ? null : JSON.stringify(ids);
  }
}

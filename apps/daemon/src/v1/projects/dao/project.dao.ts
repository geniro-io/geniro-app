import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { Project } from '../entity/project.entity';

@Injectable()
export class ProjectDao extends BaseDao<Project> {
  constructor(em: EntityManager) {
    super(em, Project);
  }

  /**
   * Every project, newest first — the whole list, since a machine holds a
   * handful of them and the picker shows them all.
   */
  async listAll(txEm?: EntityManager): Promise<Project[]> {
    return this.getAll({}, { orderBy: { createdAt: 'desc' } }, txEm);
  }

  /** The project bound to a folder, if one is. */
  async findByFolder(
    folder: string,
    txEm?: EntityManager,
  ): Promise<Project | null> {
    return this.getOne({ folder }, undefined, txEm);
  }
}

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

  /**
   * One project bound to this folder — NOT necessarily the only one.
   *
   * Nothing enforces folder uniqueness: `folder` carries no unique index and
   * `create` runs no such check, so two projects may name one directory and
   * this answers with an arbitrary one of them. Named for what it does rather
   * than for the singular contract it cannot keep; a caller that needs "the"
   * project for a folder has to settle that question first.
   */
  async findAnyByFolder(
    folder: string,
    txEm?: EntityManager,
  ): Promise<Project | null> {
    return this.getOne({ folder }, undefined, txEm);
  }
}

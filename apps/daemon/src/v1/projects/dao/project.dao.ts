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
   * A LIVE project bound to this folder, if one holds it.
   *
   * Reads through the default `softDelete` filter, which is what makes it the
   * right question to ask: a deleted project keeps its row and its folder, and
   * that folder is free again. `ProjectsService.refuseTakenFolder` is the one
   * caller and the only thing keeping the answer singular — no unique index
   * backs it, deliberately, per `Project.folder`. Named `findAny` rather than
   * `findBy` because rows written before that check existed could still
   * collide, and this would then answer with an arbitrary one of them.
   */
  async findAnyByFolder(
    folder: string,
    txEm?: EntityManager,
  ): Promise<Project | null> {
    return this.getOne({ folder }, undefined, txEm);
  }
}

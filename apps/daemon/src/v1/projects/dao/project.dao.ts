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
   * Every task key ever ISSUED — soft-deleted projects included.
   *
   * A key's uniqueness is not a question about which boards are LIVE.
   * `Run.taskIdentifier` is denormalized onto the run row and deliberately
   * outlives the task, and deleting a project deletes its tasks but not the
   * chats those tasks opened — so a removed board's `TSK-12` is still drawn in
   * the one global chat sidebar. Handing `TSK` to the next board therefore puts
   * two unrelated conversations on screen under one label, which is the defect
   * the disambiguation exists to prevent, reached through the delete.
   *
   * So the invariant is per PROJECT and settled once, when it is created: no
   * two projects ever share a key, from which it follows that no two runs can
   * carry the same prefix from different boards. Reading only live rows would
   * make it an invariant about the present, which the run rows outlive.
   *
   * The `softDelete` filter is disabled BY NAME rather than with
   * `filters: false`, for the reason `hardDeleteIncludingSoftDeleted` records:
   * the blanket form turns off every registered filter, and this package is
   * vendored to stay upstreamable into a codebase that may have more of them.
   */
  async listIssuedTaskKeys(txEm?: EntityManager): Promise<string[]> {
    const rows = await this.getRepo(txEm).find(
      {},
      { filters: { softDelete: false } },
    );
    // A project predating the column carries `null` and holds no key, so it
    // reserves none — dropped here rather than at the call site, which asks for
    // keys and should not have to know the column was added later.
    return rows
      .map((project) => project.taskKey)
      .filter((key): key is string => key !== null);
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

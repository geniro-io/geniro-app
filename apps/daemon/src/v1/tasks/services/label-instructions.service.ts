import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { ConflictException, NotFoundException } from '@packages/common';

import { ProjectDao } from '../../projects/dao/project.dao';
import { LabelInstructionDao } from '../dao/label-instruction.dao';
import { LabelInstruction } from '../entity/label-instruction.entity';
import type { Task } from '../entity/task.entity';
import type { LabelInstructionWire } from '../tasks.types';
import { parseLabels } from '../utils/task-labels';

/**
 * Instructions a task's LABELS attach automatically — pick a label from a
 * list or create one, and every task carrying it picks up whatever is
 * attached to it (`TaskRunsService.start` reads `forTask`, and
 * `composeTaskInstructions` joins the result into the run).
 */
@Injectable()
export class LabelInstructionsService {
  constructor(
    private readonly em: EntityManager,
    private readonly dao: LabelInstructionDao,
    private readonly projectDao: ProjectDao,
  ) {}

  /**
   * With a project: that board's own rows plus every GLOBAL one. Without:
   * every row on the machine — the task board's unscoped caller (the
   * all-projects view, and label suggestions), which has no one board to
   * scope to.
   *
   * Global first, then by label — the wider rule read before the board's own
   * override of it.
   */
  async list(projectId?: string): Promise<LabelInstructionWire[]> {
    const em = this.em.fork();
    if (projectId !== undefined) {
      await this.requireProject(projectId, em);
    }
    const rows = await this.dao.listForScope(projectId ?? null, em);
    return [...rows].sort(compareForList).map(toWire);
  }

  async create(input: {
    label: string;
    projectId?: string | null;
    instructions: string;
  }): Promise<LabelInstructionWire> {
    const em = this.em.fork();
    const projectId = input.projectId ?? null;
    if (projectId !== null) {
      await this.requireProject(projectId, em);
    }
    await this.refuseDuplicate(projectId, input.label, null, em);
    const created = await this.dao.create(
      { projectId, label: input.label, instructions: input.instructions },
      em,
    );
    return toWire(created);
  }

  /**
   * Change a row's label, project scope or text. An explicit `projectId: null`
   * moves it to global; an omitted key leaves that field alone.
   */
  async update(
    id: string,
    patch: {
      label?: string;
      projectId?: string | null;
      instructions?: string;
    },
  ): Promise<LabelInstructionWire> {
    const em = this.em.fork();
    const row = await this.require(id, em);
    const nextProjectId =
      patch.projectId === undefined ? row.projectId : patch.projectId;
    const nextLabel = patch.label ?? row.label;
    if (nextProjectId !== null) {
      await this.requireProject(nextProjectId, em);
    }
    if (patch.label !== undefined || patch.projectId !== undefined) {
      await this.refuseDuplicate(nextProjectId, nextLabel, id, em);
    }
    if (patch.label !== undefined) {
      row.label = patch.label;
    }
    if (patch.projectId !== undefined) {
      row.projectId = patch.projectId;
    }
    if (patch.instructions !== undefined) {
      row.instructions = patch.instructions;
    }
    await em.flush();
    return toWire(row);
  }

  async remove(id: string): Promise<{ deleted: boolean }> {
    const em = this.em.fork();
    await this.require(id, em);
    await this.dao.deleteById(id, em);
    return { deleted: true };
  }

  /**
   * The rows this task's own labels attach, in the task's label order —
   * within one label, the global row before the project one, so the wider
   * rule reads first and the board's override reads as an addition to it.
   *
   * Rows from a DIFFERENT project never reach a task, because `matching` is
   * scoped to this task's own project id.
   */
  async forTask(
    task: Pick<Task, 'projectId' | 'labels'>,
  ): Promise<LabelInstructionWire[]> {
    const labels = parseLabels(task.labels);
    if (labels.length === 0) {
      return [];
    }
    const em = this.em.fork();
    const rows = await this.dao.matching(task.projectId, labels, em);
    const byLabel = new Map<string, LabelInstruction[]>();
    for (const row of rows) {
      const bucket = byLabel.get(row.label);
      if (bucket) {
        bucket.push(row);
      } else {
        byLabel.set(row.label, [row]);
      }
    }
    const ordered: LabelInstruction[] = [];
    for (const label of labels) {
      const bucket = byLabel.get(label);
      if (bucket === undefined) {
        continue;
      }
      ordered.push(...[...bucket].sort((a, b) => scopeRank(a) - scopeRank(b)));
    }
    return ordered.map(toWire);
  }

  /** Same scope (projectId-or-null) AND same label, excluding this row itself. */
  private async refuseDuplicate(
    projectId: string | null,
    label: string,
    exceptId: string | null,
    em: EntityManager,
  ): Promise<void> {
    const existing = await this.dao.findByScopeAndLabel(projectId, label, em);
    if (existing && existing.id !== exceptId) {
      throw new ConflictException(
        'LABEL_INSTRUCTION_EXISTS',
        `an instruction for label "${label}" already exists in that scope`,
      );
    }
  }

  private async require(
    id: string,
    em: EntityManager,
  ): Promise<LabelInstruction> {
    const row = await this.dao.getById(id, em);
    if (!row) {
      throw new NotFoundException(
        'LABEL_INSTRUCTION_NOT_FOUND',
        `no label instruction with id ${id}`,
      );
    }
    return row;
  }

  private async requireProject(
    projectId: string,
    em: EntityManager,
  ): Promise<void> {
    const project = await this.projectDao.getById(projectId, em);
    if (!project) {
      throw new NotFoundException(
        'PROJECT_NOT_FOUND',
        `no project with id ${projectId}`,
      );
    }
  }
}

function scopeRank(row: LabelInstruction): number {
  return row.projectId === null ? 0 : 1;
}

function compareForList(a: LabelInstruction, b: LabelInstruction): number {
  const scope = scopeRank(a) - scopeRank(b);
  return scope !== 0 ? scope : a.label.localeCompare(b.label);
}

function toWire(row: LabelInstruction): LabelInstructionWire {
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    instructions: row.instructions,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

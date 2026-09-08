import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import {
  TASK_FILES_MAX,
  TaskFileSchema,
  type TaskFileWire,
  type TaskWire,
} from '../tasks.types';
import { TasksService } from './tasks.service';

/**
 * The files a user binds to a card — an archive, a spreadsheet, a spec.
 *
 * REPORTED as the half that was missing: "я всё ещё не могу прицеплять файлы,
 * например zip-архивы, то есть как attachments." Pasting had covered images
 * (bytes with no path, written to disk by geniro) and, for anything else, had
 * written the file's PATH into the description — which works and is invisible:
 * a path buried in prose is not an attachment, it cannot be listed, and it
 * cannot be removed.
 *
 * Every entry REFERENCES a file already on this machine and geniro copies
 * nothing — the trade is argued at `TaskFileSchema`. Two consequences live
 * here. The file must EXIST when it is attached, checked the way every other
 * user-supplied path in this daemon is (a card that names a file nobody can
 * open would be discovered by the agent, minutes later, one process away). And
 * DETACHING removes the reference and never the file.
 *
 * The list is bounded: it is read into the agent's own prompt, so an unbounded
 * one is a prompt that grows without limit.
 */
@Injectable()
export class TaskFilesService {
  constructor(
    private readonly em: EntityManager,
    private readonly taskDao: TaskDao,
    private readonly tasks: TasksService,
  ) {}

  /** Bind one file that is already on disk, and answer with the whole card. */
  async attach(taskId: string, path: string): Promise<TaskWire> {
    const em = this.em.fork();
    const task = await this.require(taskId, em);
    const held = parse(task.attachments);
    if (held.length >= TASK_FILES_MAX) {
      throw new BadRequestException(
        'TOO_MANY_ATTACHMENTS',
        `a task carries at most ${TASK_FILES_MAX} files`,
      );
    }
    const file = describe(path);
    // The SAME file twice is the ordinary double-press rather than an error,
    // and answering with the card as it stands is what a client redraws from.
    if (held.some((row) => row.path === file.path)) {
      return this.tasks.get(taskId);
    }
    task.attachments = JSON.stringify([...held, file]);
    await em.flush();
    return this.tasks.get(taskId);
  }

  /**
   * Drop one reference. The FILE is untouched — geniro did not put it there,
   * and a detach that deleted a user's own archive would be unforgivable.
   */
  async detach(taskId: string, attachmentId: string): Promise<TaskWire> {
    const em = this.em.fork();
    const task = await this.require(taskId, em);
    const held = parse(task.attachments);
    const kept = held.filter((row) => row.id !== attachmentId);
    if (kept.length !== held.length) {
      task.attachments = JSON.stringify(kept);
      await em.flush();
    }
    return this.tasks.get(taskId);
  }

  private async require(taskId: string, em: EntityManager): Promise<Task> {
    const task = await this.taskDao.getById(taskId, em);
    if (!task) {
      throw new NotFoundException(
        'TASK_NOT_FOUND',
        `no task with id ${taskId}`,
      );
    }
    return task;
  }
}

/**
 * Read a path into a row, refusing what cannot be attached.
 *
 * A DIRECTORY is refused rather than accepted as a path an agent could walk:
 * the control that produces these is a file picker, and a folder arriving here
 * means something else went wrong.
 */
function describe(raw: string): TaskFileWire {
  const path = raw.trim();
  if (path === '' || !isAbsolute(path)) {
    throw new BadRequestException(
      'ATTACHMENT_PATH_INVALID',
      `${raw} is not an absolute path`,
    );
  }
  let stat;
  try {
    stat = statSync(path);
  } catch {
    // The read IS the existence check, so its failure is the answer — and it
    // is the only statement inside the `try`, which is what keeps the refusal
    // below from being caught here and re-thrown as "no file at".
    throw new BadRequestException('ATTACHMENT_NOT_FOUND', `no file at ${path}`);
  }
  if (!stat.isFile()) {
    throw new BadRequestException(
      'ATTACHMENT_NOT_A_FILE',
      `${path} is not a file`,
    );
  }
  return { id: randomUUID(), name: basename(path), path, bytes: stat.size };
}

/** The stored column, tolerating anything an older build or a hand wrote. */
function parse(raw: string): TaskFileWire[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((row) => {
      const result = TaskFileSchema.safeParse(row);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}

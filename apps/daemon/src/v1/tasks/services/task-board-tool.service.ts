import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { RunDao } from '../../agents/dao/run.dao';
import type {
  TaskBoardCard,
  TaskBoardUpdate,
  TaskBoardUpdateOutcome,
} from '../../graphs/graphs.types';
import { TaskBoardBroker } from '../../graphs/services/task-board.broker';
import { TaskDao } from '../dao/task.dao';
import type { Task } from '../entity/task.entity';
import type { TaskWire } from '../tasks.types';
import { reportImagePaths, rewriteReportImages } from '../utils/report-images';
import { TaskAttachmentService } from './task-attachment.service';
import { TaskFilesService } from './task-files.service';
import { TasksService } from './tasks.service';

/**
 * The board's half of the `get_task` / `update_task` tools — how a task's
 * agent reads its card and writes the card's report and column.
 *
 * This is the ONLY writer of a card's report, and the only way a card leaves
 * `in_progress` on success: the settle no longer moves a card whose run
 * completed or reads a report out of its transcript. The agent decides when
 * the work is finished and says so, because the last message of a thread is
 * whatever the agent happened to say last — routinely a status line, a
 * question, or a mid-run review — and not an account of the task.
 *
 * Installed into {@link TaskBoardBroker} at boot, since the MCP host that
 * serves the tools lives in `GraphsModule`, which this module imports and
 * which may not import it back.
 */
@Injectable()
export class TaskBoardToolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskBoardToolService.name);
  private uninstall: (() => void) | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly broker: TaskBoardBroker,
    private readonly runDao: RunDao,
    private readonly taskDao: TaskDao,
    private readonly tasks: TasksService,
    private readonly attachments: TaskAttachmentService,
    private readonly files: TaskFilesService,
  ) {}

  onModuleInit(): void {
    this.uninstall = this.broker.install({
      cardFor: (runId) => this.cardFor(runId),
      update: (runId, update) => this.update(runId, update),
    });
  }

  onModuleDestroy(): void {
    this.uninstall?.();
    this.uninstall = null;
  }

  async cardFor(runId: string): Promise<TaskBoardCard | null> {
    const held = await this.heldCard(runId, this.em.fork());
    if (held === null) {
      return null;
    }
    return cardOf(await this.tasks.get(held.task.id), held.identifier);
  }

  /**
   * Write the report first and move the card second, so a card lands in its
   * new column already carrying the account of the work.
   */
  async update(
    runId: string,
    update: TaskBoardUpdate,
  ): Promise<TaskBoardUpdateOutcome> {
    const held = await this.heldCard(runId, this.em.fork());
    if (held === null) {
      return {
        status: 'refused',
        reason:
          'this conversation no longer works a card on the board — the card was deleted, or started again on another run',
      };
    }
    const taskId = held.task.id;
    let attachedImages = 0;
    const skippedImages: string[] = [];
    if (update.report !== undefined) {
      const copies = new Map<string, string>();
      for (const source of reportImagePaths(update.report)) {
        try {
          copies.set(source, await this.keepImage(taskId, source));
          attachedImages += 1;
        } catch (error) {
          // One picture the agent has since deleted must not cost it the
          // report: the rest is still the account of the work.
          skippedImages.push(source);
          this.logger.warn(
            `could not attach ${source} to task ${taskId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      await this.tasks.update(taskId, {
        report: rewriteReportImages(update.report, copies),
      });
    }
    let wire = await this.tasks.get(taskId);
    if (update.status !== undefined && wire.status !== update.status) {
      wire = await this.tasks.moveStatus(taskId, {
        from: wire.status,
        to: update.status,
      });
    }
    return {
      status: 'updated',
      card: cardOf(wire, held.identifier),
      attachedImages,
      skippedImages,
    };
  }

  /**
   * Copy one referenced image onto the card, or reuse the copy an earlier
   * report already made.
   *
   * Every `report` replaces the last, so an agent routinely sends the same
   * screenshots twice; matching the card's existing files by name and size is
   * what keeps the card from listing each picture once per report.
   */
  private async keepImage(taskId: string, source: string): Promise<string> {
    const { size } = await stat(source);
    const existing = (await this.tasks.get(taskId)).attachments.find(
      (file) =>
        file.path !== source &&
        file.name === basename(source) &&
        file.bytes === size,
    );
    if (existing !== undefined) {
      return existing.path;
    }
    const copy = await this.attachments.adopt(taskId, source);
    await this.files.attach(taskId, copy);
    return copy;
  }

  /**
   * The card a run works — only while that card still names this run, so an
   * older conversation cannot rewrite a card that has been started again.
   */
  private async heldCard(
    runId: string,
    em: EntityManager,
  ): Promise<{ task: Task; identifier: string | null } | null> {
    const run = await this.runDao.getById(runId, em);
    if (!run?.taskId) {
      return null;
    }
    const task = await this.taskDao.getById(run.taskId, em);
    if (!task || task.runId !== runId) {
      return null;
    }
    return { task, identifier: run.taskIdentifier ?? null };
  }
}

function cardOf(wire: TaskWire, identifier: string | null): TaskBoardCard {
  return {
    identifier,
    title: wire.title,
    description: wire.description,
    status: wire.status,
    report: wire.report,
  };
}

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import { resolveValidDirectory } from '../../agents/utils/resolve-directory';
import { TaskDao } from '../../tasks/dao/task.dao';
import { removeTaskAttachments } from '../../tasks/utils/task-attachments';
import { ProjectDao } from '../dao/project.dao';
import { Project } from '../entity/project.entity';
import type { ProjectWire } from '../projects.types';
import { projectKey } from '../utils/project-key';

/** How many projects one machine may hold — a guard, not a design limit. */
const MAX_PROJECTS = 200;

/**
 * Projects: a folder, and the standing answers for every task worked in it.
 *
 * It holds a {@link TaskDao} because deleting a project deletes its tasks, and
 * nothing in this daemon cascades. The DAO is provided by this module rather
 * than imported from `TasksModule`, which imports THIS one — a DAO is a
 * stateless wrapper over the shared `EntityManager`, so providing it here
 * costs an object and buys a module graph with no cycle in it and no
 * `forwardRef`.
 */
@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly projectDao: ProjectDao,
    private readonly taskDao: TaskDao,
  ) {}

  async list(): Promise<ProjectWire[]> {
    const em = this.em.fork();
    return (await this.projectDao.listAll(em)).map(toWire);
  }

  async get(projectId: string): Promise<ProjectWire> {
    const em = this.em.fork();
    return toWire(await this.require(projectId, em));
  }

  async create(input: {
    name: string;
    folder: string;
    groupId?: string;
    agentKind?: Project['agentKind'];
    model?: string;
    effort?: string;
    approval?: Project['approval'];
    configDir?: string;
    workflowSlug?: string;
    autopilotEnabled?: boolean;
    autopilotIntakeStatus?: Project['autopilotIntakeStatus'];
    autopilotMaxConcurrent?: number;
    provider?: Project['provider'];
  }): Promise<ProjectWire> {
    const em = this.em.fork();
    if ((await this.projectDao.count({}, em)) >= MAX_PROJECTS) {
      throw new BadRequestException(
        'TOO_MANY_PROJECTS',
        `a machine holds at most ${MAX_PROJECTS} projects`,
      );
    }
    const folder = resolveValidDirectory(input.folder, {
      errorCode: 'INVALID_PROJECT_FOLDER',
      noun: 'project folder',
    });
    await this.refuseTakenFolder(folder, null, em);
    const created = await this.projectDao.create(
      {
        name: input.name,
        // Derived ONCE, here, and owned by the row from then on: a rename must
        // not renumber cards that have already been quoted somewhere.
        taskKey: await this.freeTaskKey(input.name, em),
        folder,
        groupId: input.groupId ?? null,
        agentKind: input.agentKind ?? null,
        model: input.model ?? null,
        effort: input.effort ?? null,
        approval: input.approval ?? null,
        configDir: input.configDir
          ? resolveValidDirectory(input.configDir, {
              errorCode: 'INVALID_CONFIG_DIR',
              noun: 'config directory',
            })
          : null,
        workflowSlug: input.workflowSlug ?? null,
        ...(input.autopilotEnabled === undefined
          ? {}
          : { autopilotEnabled: input.autopilotEnabled }),
        ...(input.autopilotIntakeStatus === undefined
          ? {}
          : { autopilotIntakeStatus: input.autopilotIntakeStatus }),
        ...(input.autopilotMaxConcurrent === undefined
          ? {}
          : { autopilotMaxConcurrent: input.autopilotMaxConcurrent }),
        ...(input.provider === undefined ? {} : { provider: input.provider }),
      },
      em,
    );
    return toWire(created);
  }

  /**
   * Change a project's name, folder, run defaults or autopilot policy.
   *
   * An explicit `null` on a nullable field clears it; an omitted key leaves it
   * alone. Nothing here touches the project's tasks: repointing a folder is
   * not a claim about the work already on the board.
   */
  async update(
    projectId: string,
    patch: {
      name?: string;
      folder?: string;
      groupId?: string | null;
      agentKind?: Project['agentKind'];
      model?: string | null;
      effort?: string | null;
      approval?: Project['approval'];
      configDir?: string | null;
      workflowSlug?: string | null;
      autopilotEnabled?: boolean;
      autopilotIntakeStatus?: Project['autopilotIntakeStatus'];
      autopilotMaxConcurrent?: number;
    },
  ): Promise<ProjectWire> {
    const em = this.em.fork();
    const project = await this.require(projectId, em);

    if (patch.name !== undefined) {
      project.name = patch.name;
    }
    if (patch.folder !== undefined) {
      const folder = resolveValidDirectory(patch.folder, {
        errorCode: 'INVALID_PROJECT_FOLDER',
        noun: 'project folder',
      });
      await this.refuseTakenFolder(folder, project.id, em);
      project.folder = folder;
    }
    if (patch.groupId !== undefined) {
      project.groupId = patch.groupId;
    }
    if (patch.agentKind !== undefined) {
      project.agentKind = patch.agentKind;
    }
    if (patch.model !== undefined) {
      project.model = patch.model;
    }
    if (patch.effort !== undefined) {
      project.effort = patch.effort;
    }
    if (patch.approval !== undefined) {
      project.approval = patch.approval;
    }
    if (patch.configDir !== undefined) {
      project.configDir =
        patch.configDir === null
          ? null
          : resolveValidDirectory(patch.configDir, {
              errorCode: 'INVALID_CONFIG_DIR',
              noun: 'config directory',
            });
    }
    if (patch.workflowSlug !== undefined) {
      project.workflowSlug = patch.workflowSlug;
    }
    if (patch.autopilotEnabled !== undefined) {
      project.autopilotEnabled = patch.autopilotEnabled;
    }
    if (patch.autopilotIntakeStatus !== undefined) {
      project.autopilotIntakeStatus = patch.autopilotIntakeStatus;
    }
    if (patch.autopilotMaxConcurrent !== undefined) {
      project.autopilotMaxConcurrent = patch.autopilotMaxConcurrent;
    }

    await em.flush();
    return toWire(project);
  }

  /**
   * Clear the failure streak, which is the only way a tripped breaker closes.
   *
   * A deliberate press rather than a field on the patch above, and that is the
   * whole point of it: the breaker opened because runs kept failing, so
   * whatever it is guarding against is presumed still there until a person
   * says otherwise. A client that could zero the count as part of an ordinary
   * settings write could clear it without ever having looked.
   *
   * Idempotent — re-arming a project whose streak is already zero is a no-op
   * that succeeds, so a second press costs nothing.
   */
  async rearmAutopilot(projectId: string): Promise<ProjectWire> {
    const em = this.em.fork();
    const project = await this.require(projectId, em);
    if (project.autopilotFailureStreak !== 0) {
      project.autopilotFailureStreak = 0;
      await em.flush();
    }
    return toWire(project);
  }

  /**
   * Delete a project AND every task on its board.
   *
   * The tasks go explicitly, one call, because nothing in this daemon
   * cascades — the database will not do it and a task left behind would name a
   * project that no longer exists, invisible on every board and still matching
   * the autopilot's cross-project intake query.
   *
   * Both deletes are soft (`BaseDao.delete` stamps `deletedAt`, the
   * `softDelete` filter hides the rows), the same one-way-door-free shape as
   * archiving a chat rather than purging it.
   */
  async remove(
    projectId: string,
  ): Promise<{ deleted: boolean; tasksRemoved: number }> {
    const em = this.em.fork();
    await this.require(projectId, em);
    const doomed = await this.taskDao.listForProject(projectId, em);
    const tasksRemoved = await this.taskDao.countInProject(projectId, em);
    // One transaction, because half of this is worse than none of it: the
    // tasks go first, so a failure between the two writes would leave a board
    // standing with every card hidden and nothing to retry it.
    await em.transactional(async (tx) => {
      await this.taskDao.deleteForProject(projectId, tx);
      await this.projectDao.deleteById(projectId, tx);
    });
    // Each card's pasted images, on `TasksService.remove`'s own reasoning:
    // after the rows, outside the transaction, and one failure stepped over
    // rather than thrown — the board is already gone, so a permission error on
    // one directory must not report a delete that happened as having failed.
    for (const task of doomed) {
      try {
        await removeTaskAttachments(task.id);
      } catch (error) {
        this.logger.warn(
          `could not drop attachments for task ${task.id}: ${String(error)}`,
        );
      }
    }
    return { deleted: true, tasksRemoved };
  }

  /**
   * The card key this project will use — the derived one, or the first free
   * variant of it.
   *
   * Nothing keeps `taskKey` unique and no client can set or edit it: it is
   * DERIVED, one initial per word, so two boards collide readily and every
   * name with no Latin letters at all derives the same fallback. The chat
   * sidebar draws `Run.taskIdentifier` in ONE global list, so a collision puts
   * two different cards on screen both labelled `GW-12`, with nothing to tell
   * them apart.
   *
   * A digit is APPENDED rather than the create refused — unlike the folder
   * check below, which refuses. The difference is whose value it is: a folder
   * is chosen by the user and a clash is theirs to resolve, while this string
   * is one they never typed and cannot see, so blocking a create over it would
   * be refusing them for something they did not do.
   *
   * Settled ONCE, here, and never re-derived per task: the invariant is that
   * every PROJECT holds a distinct key, from which a run's label being
   * unambiguous follows for free. Asked at task-create time it would be a
   * different and weaker rule — the label is stamped onto the run row and
   * outlives the card, so a key that was unique when a task was made says
   * nothing about the key a later board is given.
   */
  private async freeTaskKey(name: string, em: EntityManager): Promise<string> {
    const base = projectKey(name);
    // Every key ever ISSUED, not every key currently held: see
    // `ProjectDao.listIssuedTaskKeys` for why a deleted board's key may not be
    // handed out again.
    const taken = new Set(await this.projectDao.listIssuedTaskKeys(em));
    if (!taken.has(base)) {
      return base;
    }
    // Bounded by PIGEONHOLE rather than by the project cap, which no longer
    // bounds `taken` now that it counts deleted boards too: among the
    // `taken.size + 1` candidates this loop tries, at most `taken.size` can be
    // taken, so one of them is always free and the fallback below is
    // unreachable. Sizing this by `MAX_PROJECTS` instead would let a machine
    // that had created and deleted enough boards exhaust the loop and fall back
    // to a `base` it had just proved was taken.
    for (let suffix = 2; suffix <= taken.size + 2; suffix += 1) {
      const candidate = `${base}${suffix}`;
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
    return base;
  }

  /**
   * Refuse a folder another project already holds.
   *
   * Checked here as well as by the unique index, so the caller gets a named
   * refusal rather than a driver error — and on UPDATE too, which is the path
   * that would otherwise move a second project onto an occupied folder.
   */
  private async refuseTakenFolder(
    folder: string,
    exceptProjectId: string | null,
    em: EntityManager,
  ): Promise<void> {
    const holder = await this.projectDao.findAnyByFolder(folder, em);
    if (holder && holder.id !== exceptProjectId) {
      throw new BadRequestException(
        'FOLDER_ALREADY_A_PROJECT',
        `${holder.name} already uses that folder`,
      );
    }
  }

  private async require(
    projectId: string,
    em: EntityManager,
  ): Promise<Project> {
    const project = await this.projectDao.getById(projectId, em);
    if (!project) {
      throw new NotFoundException(
        'PROJECT_NOT_FOUND',
        `no project with id ${projectId}`,
      );
    }
    return project;
  }
}

function toWire(project: Project): ProjectWire {
  return {
    id: project.id,
    name: project.name,
    taskKey: project.taskKey,
    folder: project.folder,
    groupId: project.groupId,
    agentKind: project.agentKind,
    model: project.model,
    effort: project.effort,
    approval: project.approval,
    configDir: project.configDir,
    workflowSlug: project.workflowSlug,
    autopilotEnabled: project.autopilotEnabled,
    autopilotIntakeStatus: project.autopilotIntakeStatus,
    autopilotMaxConcurrent: project.autopilotMaxConcurrent,
    autopilotFailureStreak: project.autopilotFailureStreak,
    provider: project.provider,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

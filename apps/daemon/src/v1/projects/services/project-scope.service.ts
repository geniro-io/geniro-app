import { homedir } from 'node:os';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import type { Run } from '../../runs/entity/run.entity';
import { TaskDao } from '../../tasks/dao/task.dao';
import { ProjectDao } from '../dao/project.dao';
import type { Project } from '../entity/project.entity';
import type {
  RunPlacement,
  RunProject,
  RunProjectFacts,
} from '../projects.types';
import { projectInstructionsText } from '../utils/project-instructions';
import { ProjectRootsService } from './project-roots.service';

/** The columns a run's project is read from. */
export type RunProjectColumns = Pick<
  Run,
  'projectId' | 'projectSource' | 'taskId' | 'cwd'
>;

/**
 * Which project a run belongs to — the one resolution its shared memory and its
 * project instructions both follow.
 */
@Injectable()
export class ProjectScopeService {
  private readonly logger = new Logger(ProjectScopeService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly tasks: TaskDao,
    private readonly projects: ProjectDao,
    private readonly roots: ProjectRootsService,
  ) {}

  /**
   * The project a new run belongs to: the one it was started under by choice
   * (an unknown or deleted one is passed over), else none when that choice was
   * none, else its task card's project while it exists, else the live project
   * bound to its folder or to the closest folder above it (a task worktree
   * resolves to its repository first; the home folder and the root count only
   * exactly), else none.
   */
  async projectOf(facts: RunProjectFacts): Promise<RunProject> {
    const em = this.em.fork();
    if (facts.projectId === null) {
      return { project: null, source: 'explicit' };
    }
    if (facts.projectId !== undefined) {
      const chosen = await this.projects.getById(facts.projectId, em);
      if (chosen) {
        return { project: chosen, source: 'explicit' };
      }
    }
    const card = await this.cardProjectOf(facts.taskId, em);
    if (card) {
      return { project: card, source: 'card' };
    }
    if (facts.cwd === null) {
      return { project: null, source: 'none' };
    }
    const nearest = await this.projects.findNearestByFolder(
      await this.rootOf(facts.cwd),
      homedir(),
      em,
    );
    return nearest
      ? { project: nearest, source: 'folder' }
      : { project: null, source: 'none' };
  }

  /**
   * What a new run keeps of its project for its whole life, taken once at
   * creation: the instructions reach `AgentAdapter.sessionKey`, so a live read
   * would respawn a kept CLI whenever the user edited the project. A failed
   * read costs the run its project, never its start.
   */
  async placeNewRun(facts: RunProjectFacts): Promise<RunPlacement> {
    try {
      const { project, source } = await this.projectOf(facts);
      return {
        projectId: project?.id ?? null,
        chosenProjectGroupId:
          source === 'explicit' ? (project?.groupId ?? null) : null,
        source,
        instructions: project ? projectInstructionsText(project) : null,
      };
    } catch (error) {
      this.logger.warn(
        `project not read: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        projectId: null,
        chosenProjectGroupId: null,
        source: null,
        instructions: null,
      };
    }
  }

  /**
   * The live project of a run that exists: the one settled at its creation,
   * else — a run created before that was recorded — its task card's project,
   * else the project bound to exactly its folder.
   */
  async projectOfRun(run: RunProjectColumns): Promise<Project | null> {
    const em = this.em.fork();
    if (run.projectSource !== null) {
      return run.projectId === null
        ? null
        : this.projects.getById(run.projectId, em);
    }
    const card = await this.cardProjectOf(run.taskId, em);
    if (card || run.cwd === null) {
      return card;
    }
    return this.projects.findAnyByFolder(await this.rootOf(run.cwd), em);
  }

  /** The names of the projects among `ids` that still exist, by id — one read per listing. */
  async liveNamesOf(
    ids: Iterable<string | null>,
  ): Promise<ReadonlyMap<string, string>> {
    const wanted = [...new Set(ids)].filter((id): id is string => id !== null);
    if (wanted.length === 0) {
      return new Map();
    }
    const live = await this.projects.listRefs(this.em.fork());
    return new Map(
      live
        .filter((project) => wanted.includes(project.id))
        .map((project) => [project.id, project.name]),
    );
  }

  private async cardProjectOf(
    taskId: string | null,
    em: EntityManager,
  ): Promise<Project | null> {
    if (taskId === null) {
      return null;
    }
    const task = await this.tasks.getById(taskId, em);
    return task ? this.projects.getById(task.projectId, em) : null;
  }

  private async rootOf(cwd: string): Promise<string> {
    return (await this.roots.rootsOf([cwd])).get(cwd) ?? cwd;
  }
}

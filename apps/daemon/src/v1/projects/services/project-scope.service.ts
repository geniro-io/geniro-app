import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import { TaskDao } from '../../tasks/dao/task.dao';
import { ProjectDao } from '../dao/project.dao';
import type { Project } from '../entity/project.entity';
import type { RunProjectFacts } from '../projects.types';
import { projectInstructionsText } from '../utils/project-instructions';
import { ProjectRootsService } from './project-roots.service';

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
   * The run's task card's project if it still exists, else the live project
   * whose folder the run works in (a task worktree resolves to its repository;
   * a subfolder matches none), else none.
   */
  async projectOf({ taskId, cwd }: RunProjectFacts): Promise<Project | null> {
    const em = this.em.fork();
    if (taskId !== null) {
      const task = await this.tasks.getById(taskId, em);
      const project = task
        ? await this.projects.getById(task.projectId, em)
        : null;
      if (project) {
        return project;
      }
    }
    if (cwd === null) {
      return null;
    }
    const root = (await this.roots.rootsOf([cwd])).get(cwd) ?? cwd;
    return this.projects.findAnyByFolder(root, em);
  }

  /**
   * What a new run keeps of its project's instructions for its whole life.
   * Taken once, at creation: the text reaches `AgentAdapter.sessionKey`, so a
   * live read would respawn a kept CLI whenever the user edited the project. A
   * failed read costs the run the text, never its start.
   */
  async instructionsSnapshot(facts: RunProjectFacts): Promise<string | null> {
    try {
      const project = await this.projectOf(facts);
      return project ? projectInstructionsText(project) : null;
    } catch (error) {
      this.logger.warn(
        `project instructions not read: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}

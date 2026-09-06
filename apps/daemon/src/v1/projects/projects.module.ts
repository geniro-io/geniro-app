import { Module } from '@nestjs/common';

import { TaskDao } from '../tasks/dao/task.dao';
import { ProjectsController } from './controllers/projects.controller';
import { ProjectDao } from './dao/project.dao';
import { ProjectsService } from './services/projects.service';

/**
 * Projects — the folder a board's work happens in.
 *
 * It provides {@link TaskDao} rather than importing `TasksModule`, and that is
 * the deliberate half of the wiring: `TasksModule` imports THIS module (a task
 * belongs to a project, so it validates against `ProjectDao`), so importing it
 * back would be a cycle needing `forwardRef` — the same trap
 * `RunGroupsService`'s doc block describes. A DAO is a stateless wrapper over
 * the shared `EntityManager`, so providing one here costs an object and keeps
 * the module graph acyclic.
 */
@Module({
  controllers: [ProjectsController],
  providers: [ProjectDao, TaskDao, ProjectsService],
  exports: [ProjectDao],
})
export class ProjectsModule {}

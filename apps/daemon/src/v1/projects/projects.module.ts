import { Module } from '@nestjs/common';

import { RunDao } from '../agents/dao/run.dao';
import { TaskDao } from '../tasks/dao/task.dao';
import { ProjectsController } from './controllers/projects.controller';
import { ProjectDao } from './dao/project.dao';
import { ProjectQueueService } from './services/project-queue.service';
import { ProjectsService } from './services/projects.service';
import { TaskNumberBackfillService } from './services/task-number-backfill.service';

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
 *
 * {@link RunDao} is here on the same terms and for the same reason: the queue
 * counts how many of a project's cards hold a run that is still LIVE, which
 * only the run rows can answer, and importing `AgentsModule` for one stateless
 * DAO would pull the whole agent substrate in behind it.
 */
@Module({
  controllers: [ProjectsController],
  providers: [
    ProjectDao,
    TaskDao,
    RunDao,
    ProjectsService,
    ProjectQueueService,
    TaskNumberBackfillService,
  ],
  exports: [ProjectDao, ProjectQueueService, TaskNumberBackfillService],
})
export class ProjectsModule {}

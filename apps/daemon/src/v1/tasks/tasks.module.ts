import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module';
import { TasksController } from './controllers/tasks.controller';
import { TaskDao } from './dao/task.dao';
import { TasksService } from './services/tasks.service';

/**
 * Tasks — the cards on a project's board.
 *
 * Imports `ProjectsModule` for `ProjectDao`, because a task must name a
 * project that exists. The dependency runs in this direction only; see
 * `ProjectsModule`'s note on how the reverse need is met without a cycle.
 */
@Module({
  imports: [ProjectsModule],
  controllers: [TasksController],
  providers: [TaskDao, TasksService],
  exports: [TaskDao],
})
export class TasksModule {}

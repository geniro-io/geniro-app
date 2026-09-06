import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module';
import { TasksController } from './controllers/tasks.controller';
import { TaskDao } from './dao/task.dao';
import { TaskEventBus } from './services/task-events.bus';
import { TasksService } from './services/tasks.service';

/**
 * Tasks — the cards on a project's board.
 *
 * Imports `ProjectsModule` for `ProjectDao`, because a task must name a
 * project that exists. The dependency runs in this direction only; see
 * `ProjectsModule`'s note on how the reverse need is met without a cycle.
 *
 * `TaskEventBus` is exported for `NotificationsModule`, on `AgentEventBus`'s
 * own precedent: the module that writes the rows owns the bus, and the WS
 * gateway is the one fan-out subscriber.
 */
@Module({
  imports: [ProjectsModule],
  controllers: [TasksController],
  providers: [TaskDao, TaskEventBus, TasksService],
  exports: [TaskDao, TaskEventBus],
})
export class TasksModule {}

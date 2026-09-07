import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { ProjectsModule } from '../projects/projects.module';
import { TasksController } from './controllers/tasks.controller';
import { TaskDao } from './dao/task.dao';
import { TaskEventBus } from './services/task-events.bus';
import { TaskRunsService } from './services/task-runs.service';
import { TaskSettleService } from './services/task-settle.service';
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
 *
 * It also imports `AgentsModule`, for `ChatService`: pressing Run on a card
 * starts an ORDINARY chat, so this module borrows that engine rather than
 * growing one. The import runs THIS way only — `AgentsModule` must never
 * import the tasks module back — which is the same direction `GraphsModule`
 * already takes to the same place, and is what keeps the graph acyclic.
 */
@Module({
  imports: [ProjectsModule, AgentsModule],
  controllers: [TasksController],
  providers: [
    TaskDao,
    TaskEventBus,
    TasksService,
    TaskRunsService,
    TaskSettleService,
  ],
  exports: [TaskDao, TaskEventBus],
})
export class TasksModule {}

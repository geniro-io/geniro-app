import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { GraphsModule } from '../graphs/graphs.module';
import { ProjectsModule } from '../projects/projects.module';
import { TaskQueueController } from './controllers/task-queue.controller';
import { TasksController } from './controllers/tasks.controller';
import { TaskDao } from './dao/task.dao';
import { TaskAttachmentService } from './services/task-attachment.service';
import { TaskEventBus } from './services/task-events.bus';
import { TaskFilesService } from './services/task-files.service';
import { TaskQueueService } from './services/task-queue.service';
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
 *
 * And `GraphsModule`, for `GraphExecutorService`, on exactly the same terms: a
 * card may name a WORKFLOW instead of an agent, and the second engine is
 * borrowed rather than rebuilt. Acyclic for the same reason — `GraphsModule`
 * imports `AgentsModule` and nothing else here, so tasks → graphs → agents runs
 * one way throughout.
 *
 * `TaskQueueController` / `TaskQueueService` are the reason both imports are
 * needed TOGETHER: splitting a project's waiting cards into eligible/blocked
 * needs `ProjectQueueService`'s raw read (from `ProjectsModule`) AND the
 * workflow library (`WorkflowStoreService`, from `GraphsModule`) to check a
 * card's workflow slug still exists — a question `ProjectsModule` alone has
 * no way to answer. The controller keeps the `v1/projects/:projectId/queue`
 * URL it has always answered on; see its own doc for why it lives here.
 */
@Module({
  imports: [ProjectsModule, AgentsModule, GraphsModule],
  controllers: [TasksController, TaskQueueController],
  providers: [
    TaskDao,
    TaskEventBus,
    TaskAttachmentService,
    TaskFilesService,
    TasksService,
    TaskRunsService,
    TaskSettleService,
    TaskQueueService,
  ],
  exports: [TaskDao, TaskEventBus],
})
export class TasksModule {}

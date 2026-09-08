import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { ProjectQueueDto } from '../../projects/dto/project.dto';
import type { ProjectQueue } from '../../projects/projects.types';
import { TaskQueueService } from '../services/task-queue.service';

/**
 * What one project's autopilot may start right now.
 *
 * Declared under `v1/projects` — the SAME path, tags and operation id
 * `ProjectsController` uses for its own routes — because the question is a
 * TASKS one even though its address names projects: deciding which waiting
 * cards may actually start needs both `ProjectQueueService`'s raw counts AND
 * the workflow library (`WorkflowStoreService`, owned by `GraphsModule`), and
 * `ProjectsModule` cannot import `GraphsModule` to ask that itself without
 * recreating the cycle its own module doc refuses — `TasksModule` already
 * imports `ProjectsModule`, so the reverse import would need a `forwardRef`.
 * `TasksModule` already imports both, so `TaskQueueService` lives here
 * instead. The URL, tags and operation id stay frozen at what
 * `ProjectsController` would otherwise have declared, which is what lets the
 * COMMITTED generated client and every renderer call site describe this
 * route the same way regardless of which module answers it.
 */
@Controller('v1/projects')
@ApiTags('projects')
@ApiBearerAuth()
export class TaskQueueController {
  constructor(private readonly queue: TaskQueueService) {}

  @Get(':projectId/queue')
  @ApiOperation({ operationId: 'readProjectQueue' })
  @ZodResponse({ status: 200, type: ProjectQueueDto })
  read(@Param('projectId') projectId: string): Promise<ProjectQueue> {
    return this.queue.read(projectId);
  }
}

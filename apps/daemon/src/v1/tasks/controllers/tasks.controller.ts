import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import {
  CreateTaskDto,
  ListTasksQueryDto,
  MoveTaskStatusDto,
  TaskDeletedDto,
  TaskDto,
  UpdateTaskDto,
} from '../dto/task.dto';
import { ReconcileTasksDto, StartTaskRunDto } from '../dto/task-run.dto';
import { TaskRunsService } from '../services/task-runs.service';
import { TaskSettleService } from '../services/task-settle.service';
import { TasksService } from '../services/tasks.service';
import type { TaskWire } from '../tasks.types';

/**
 * Tasks — the cards on a project's board (token-gated by the global
 * LoopbackTokenGuard).
 */
@Controller('v1/tasks')
@ApiTags('tasks')
@ApiBearerAuth()
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly taskRuns: TaskRunsService,
    private readonly settle: TaskSettleService,
  ) {}

  /**
   * One project's board. Scoped by query rather than served unfiltered: every
   * screen that reads tasks is looking at one project, and an unscoped list
   * would be a table scan the board never needs.
   */
  @Get()
  @ApiOperation({ operationId: 'listTasks' })
  @ZodResponse({ status: 200, type: [TaskDto] })
  list(@Query() query: ListTasksQueryDto): Promise<TaskWire[]> {
    return this.tasks.listForProject(query.projectId);
  }

  @Post()
  @ApiOperation({ operationId: 'createTask' })
  @ZodResponse({ status: 201, type: TaskDto })
  create(@Body() dto: CreateTaskDto): Promise<TaskWire> {
    return this.tasks.create(dto);
  }

  /**
   * Catch a board up on runs that settled while it was closed.
   *
   * Declared BEFORE the `:taskId` routes so the path is never read as a task
   * id — the same ordering `forget-custom-instructions` takes on the chat
   * controller. It answers with the board so one call serves the load.
   */
  @Post('reconcile')
  @ApiOperation({ operationId: 'reconcileTasks' })
  @ZodResponse({ status: 200, type: [TaskDto] })
  reconcile(@Body() dto: ReconcileTasksDto): Promise<TaskWire[]> {
    return this.settle.reconcileProject(dto.projectId);
  }

  @Get(':taskId')
  @ApiOperation({ operationId: 'readTask' })
  @ZodResponse({ status: 200, type: TaskDto })
  read(@Param('taskId') taskId: string): Promise<TaskWire> {
    return this.tasks.get(taskId);
  }

  @Patch(':taskId')
  @ApiOperation({ operationId: 'updateTask' })
  @ZodResponse({ status: 200, type: TaskDto })
  update(
    @Param('taskId') taskId: string,
    @Body() dto: UpdateTaskDto,
  ): Promise<TaskWire> {
    return this.tasks.update(taskId, dto);
  }

  /**
   * Move a card between columns. The body carries the status the caller is
   * moving FROM, and a stale one is refused — see {@link MoveTaskStatusDto}.
   */
  @Patch(':taskId/status')
  @ApiOperation({ operationId: 'moveTaskStatus' })
  @ZodResponse({ status: 200, type: TaskDto })
  moveStatus(
    @Param('taskId') taskId: string,
    @Body() dto: MoveTaskStatusDto,
  ): Promise<TaskWire> {
    return this.tasks.moveStatus(taskId, dto);
  }

  @Delete(':taskId')
  @ApiOperation({ operationId: 'deleteTask' })
  @ZodResponse({ status: 200, type: TaskDeletedDto })
  remove(@Param('taskId') taskId: string): Promise<{ deleted: boolean }> {
    return this.tasks.remove(taskId);
  }

  /**
   * Start an agent on this task, in a worktree the caller has already made.
   *
   * Answers with the TASK rather than the run: the board is what the presser
   * is looking at, and the card now carries the run's id, its branch and its
   * worktree — everything needed to open the conversation from here.
   */
  @Post(':taskId/runs')
  @ApiOperation({ operationId: 'startTaskRun' })
  @ZodResponse({ status: 201, type: TaskDto })
  startRun(
    @Param('taskId') taskId: string,
    @Body() dto: StartTaskRunDto,
  ): Promise<TaskWire> {
    return this.taskRuns.start(taskId, dto);
  }
}

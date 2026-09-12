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

import type { LocalImageWire } from '../../agents/chat.types';
import { LocalImageDto } from '../../agents/dto/chat.dto';
import { LocalImageService } from '../../agents/services/local-image.service';
import {
  AddTaskAttachmentDto,
  AttachTaskFileDto,
  CreateTaskDto,
  ListTasksQueryDto,
  MoveTaskStatusDto,
  TaskAttachmentDto,
  TaskDeletedDto,
  TaskDto,
  TaskImageQueryDto,
  UpdateTaskDto,
} from '../dto/task.dto';
import {
  FindFinishedTasksDto,
  FinishedTasksDto,
  ReconcileTasksDto,
  StartTaskRunDto,
} from '../dto/task-run.dto';
import { TaskAttachmentService } from '../services/task-attachment.service';
import { TaskFilesService } from '../services/task-files.service';
import { TaskRunsService } from '../services/task-runs.service';
import { TaskSettleService } from '../services/task-settle.service';
import { TasksService } from '../services/tasks.service';
import type { TaskAttachmentWire, TaskWire } from '../tasks.types';

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
    private readonly attachments: TaskAttachmentService,
    private readonly files: TaskFilesService,
    private readonly localImages: LocalImageService,
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

  /**
   * Which of these tasks' work is finished — asked by the Electron main
   * process's worktree reaper, which knows which worktrees exist and nothing
   * about what became of their cards. Declared before the `:taskId` routes,
   * beside `reconcile`.
   */
  @Post('finished')
  @ApiOperation({ operationId: 'findFinishedTasks' })
  @ZodResponse({ status: 200, type: FinishedTasksDto })
  finished(@Body() dto: FindFinishedTasksDto): Promise<{ taskIds: string[] }> {
    return this.tasks.finishedAmong(dto.taskIds);
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

  /**
   * Take one picture pasted into this card's description and write it where an
   * agent can open it.
   *
   * It answers with the PATH rather than an id, because the caller's next act
   * is to write `![name](path)` into the description — the reference has to be
   * something both readers of that markdown can act on. See
   * `TaskAttachmentService`.
   */
  @Post(':taskId/attachments')
  @ApiOperation({ operationId: 'addTaskAttachment' })
  @ZodResponse({ status: 201, type: TaskAttachmentDto })
  async addAttachment(
    @Param('taskId') taskId: string,
    @Body() dto: AddTaskAttachmentDto,
  ): Promise<TaskAttachmentWire> {
    // The card is required to EXIST before anything is written: without it a
    // path could be minted under any id a caller invented, and nothing would
    // ever collect the directory.
    await this.tasks.get(taskId);
    return this.attachments.save(taskId, dto.mediaType, dto.data, dto.name);
  }

  /**
   * Bind a file the user picked to this card — an archive, a spec, a
   * spreadsheet.
   *
   * A PATH and not bytes, which is the whole design: the file is already on
   * this machine, the agent that reads the card can open it, and copying it
   * would go stale the moment the user edited it. See `TaskFileSchema`.
   *
   * Answers with the whole CARD rather than the row, because the list is what
   * the panel redraws and a client that merged one row itself would be a
   * second place the order is decided.
   */
  @Post(':taskId/files')
  @ApiOperation({ operationId: 'attachTaskFile' })
  @ZodResponse({ status: 201, type: TaskDto })
  attachFile(
    @Param('taskId') taskId: string,
    @Body() dto: AttachTaskFileDto,
  ): Promise<TaskWire> {
    return this.files.attach(taskId, dto.path);
  }

  /**
   * Drop one reference. The FILE is left exactly where it is — geniro did not
   * put it there, and this is not a delete.
   */
  @Delete(':taskId/files/:attachmentId')
  @ApiOperation({ operationId: 'detachTaskFile' })
  @ZodResponse({ status: 200, type: TaskDto })
  detachFile(
    @Param('taskId') taskId: string,
    @Param('attachmentId') attachmentId: string,
  ): Promise<TaskWire> {
    return this.files.detach(taskId, attachmentId);
  }

  /**
   * A picture the description references, read back as base64 for the panel.
   *
   * The same reader the transcript uses (`LocalImageService`), through its
   * run-free entry point: a card has no cwd to measure a relative reference
   * against, so this route takes absolute paths only.
   */
  @Get(':taskId/image')
  @ApiOperation({ operationId: 'readTaskImage' })
  @ZodResponse({ status: 200, type: LocalImageDto })
  async readImage(
    @Param('taskId') taskId: string,
    @Query() query: TaskImageQueryDto,
  ): Promise<LocalImageWire> {
    await this.tasks.get(taskId);
    return this.localImages.readAbsolute(query.path);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import type { RunWire } from '../../agents/chat.types';
import { CancelledDto, RunDto } from '../../agents/dto/chat.dto';
import {
  CreateWorkflowDto,
  DeletedDto,
  ExportedDto,
  ExportWorkflowDto,
  ImportWorkflowDto,
  NodeStateDto,
  RunWorkflowDto,
  SaveWorkflowDto,
  WorkflowFileDto,
  WorkflowSummaryDto,
} from '../dto/workflows.dto';
import type {
  NodeStateWire,
  WorkflowSummary,
  WorkflowWire,
} from '../graphs.types';
import { GraphExecutorService } from '../services/graph-executor.service';
import { WorkflowStoreService } from '../services/workflow-store.service';

/**
 * Loopback workflow REST surface (token-gated by the global
 * LoopbackTokenGuard): library CRUD over the `*.geniro.yaml` files plus the
 * run endpoints that hand a workflow to the DAG executor. The static `runs`
 * routes are declared before the `:slug` routes so Nest never captures "runs"
 * as a slug. Run transcripts replay over the existing
 * `GET /v1/chats/:runId/items` history read (items are run-scoped, not
 * workflow-scoped) and stream over `/ws`.
 */
@Controller('v1/workflows')
@ApiTags('workflows')
@ApiBearerAuth()
export class WorkflowsController {
  constructor(
    private readonly store: WorkflowStoreService,
    private readonly executor: GraphExecutorService,
  ) {}

  @Get('runs')
  @ApiOperation({ operationId: 'listWorkflowRuns' })
  @ZodResponse({ status: 200, type: [RunDto] })
  listRuns(): Promise<RunWire[]> {
    return this.executor.listRuns();
  }

  @Get('runs/:runId/nodes')
  @ApiOperation({ operationId: 'listWorkflowRunNodes' })
  @ZodResponse({ status: 200, type: [NodeStateDto] })
  getRunNodes(@Param('runId') runId: string): Promise<NodeStateWire[]> {
    return this.executor.getNodeStates(runId);
  }

  @Post('runs/:runId/cancel')
  @ApiOperation({ operationId: 'cancelWorkflowRun' })
  @ZodResponse({ status: 200, type: CancelledDto })
  cancelRun(@Param('runId') runId: string): Promise<{ cancelled: boolean }> {
    return this.executor.cancel(runId);
  }

  @Get()
  @ApiOperation({ operationId: 'listWorkflows' })
  @ZodResponse({ status: 200, type: [WorkflowSummaryDto] })
  list(): Promise<WorkflowSummary[]> {
    return this.store.list();
  }

  @Post()
  @ApiOperation({ operationId: 'createWorkflow' })
  @ZodResponse({ status: 201, type: WorkflowFileDto })
  create(@Body() dto: CreateWorkflowDto): Promise<WorkflowWire> {
    return this.store.create(dto.workflow, dto.slug);
  }

  @Post('import')
  @ApiOperation({ operationId: 'importWorkflow' })
  @ZodResponse({ status: 201, type: WorkflowFileDto })
  import(@Body() dto: ImportWorkflowDto): Promise<WorkflowWire> {
    return this.store.importFrom(dto.path);
  }

  @Get(':slug')
  @ApiOperation({ operationId: 'getWorkflow' })
  @ZodResponse({ status: 200, type: WorkflowFileDto })
  get(@Param('slug') slug: string): Promise<WorkflowWire> {
    return this.store.get(slug);
  }

  @Put(':slug')
  @ApiOperation({ operationId: 'saveWorkflow' })
  @ZodResponse({ status: 200, type: WorkflowFileDto })
  save(
    @Param('slug') slug: string,
    @Body() dto: SaveWorkflowDto,
  ): Promise<WorkflowWire> {
    return this.store.save(slug, dto.workflow);
  }

  @Delete(':slug')
  @ApiOperation({ operationId: 'deleteWorkflow' })
  @ZodResponse({ status: 200, type: DeletedDto })
  async delete(@Param('slug') slug: string): Promise<{ deleted: boolean }> {
    await this.store.delete(slug);
    return { deleted: true };
  }

  @Post(':slug/export')
  @ApiOperation({ operationId: 'exportWorkflow' })
  @ZodResponse({ status: 200, type: ExportedDto })
  async export(
    @Param('slug') slug: string,
    @Body() dto: ExportWorkflowDto,
  ): Promise<{ exported: boolean }> {
    await this.store.exportTo(slug, dto.path);
    return { exported: true };
  }

  @Post(':slug/runs')
  @ApiOperation({ operationId: 'startWorkflowRun' })
  @ZodResponse({ status: 201, type: RunDto })
  run(
    @Param('slug') slug: string,
    @Body() dto: RunWorkflowDto,
  ): Promise<RunWire> {
    return this.executor.startRunBySlug(slug, dto);
  }
}

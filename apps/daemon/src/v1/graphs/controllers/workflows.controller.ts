import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';

import type { RunWire } from '../../agents/chat.types';
import {
  CreateWorkflowDto,
  ExportWorkflowDto,
  ImportWorkflowDto,
  RunWorkflowDto,
  SaveWorkflowDto,
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
export class WorkflowsController {
  constructor(
    private readonly store: WorkflowStoreService,
    private readonly executor: GraphExecutorService,
  ) {}

  @Get('runs')
  listRuns(): Promise<RunWire[]> {
    return this.executor.listRuns();
  }

  @Get('runs/:runId/nodes')
  getRunNodes(@Param('runId') runId: string): Promise<NodeStateWire[]> {
    return this.executor.getNodeStates(runId);
  }

  @Post('runs/:runId/cancel')
  cancelRun(@Param('runId') runId: string): Promise<{ cancelled: boolean }> {
    return this.executor.cancel(runId);
  }

  @Get()
  list(): Promise<WorkflowSummary[]> {
    return this.store.list();
  }

  @Post()
  create(@Body() dto: CreateWorkflowDto): Promise<WorkflowWire> {
    return this.store.create(dto.workflow, dto.slug);
  }

  @Post('import')
  import(@Body() dto: ImportWorkflowDto): Promise<WorkflowWire> {
    return this.store.importFrom(dto.path);
  }

  @Get(':slug')
  get(@Param('slug') slug: string): Promise<WorkflowWire> {
    return this.store.get(slug);
  }

  @Put(':slug')
  save(
    @Param('slug') slug: string,
    @Body() dto: SaveWorkflowDto,
  ): Promise<WorkflowWire> {
    return this.store.save(slug, dto.workflow);
  }

  @Delete(':slug')
  async delete(@Param('slug') slug: string): Promise<{ deleted: boolean }> {
    await this.store.delete(slug);
    return { deleted: true };
  }

  @Post(':slug/export')
  async export(
    @Param('slug') slug: string,
    @Body() dto: ExportWorkflowDto,
  ): Promise<{ exported: boolean }> {
    await this.store.exportTo(slug, dto.path);
    return { exported: true };
  }

  @Post(':slug/runs')
  async run(
    @Param('slug') slug: string,
    @Body() dto: RunWorkflowDto,
  ): Promise<RunWire> {
    const { workflow } = await this.store.get(slug);
    return this.executor.startRun({
      slug,
      workflow,
      cwd: dto.cwd,
      prompt: dto.prompt,
    });
  }
}

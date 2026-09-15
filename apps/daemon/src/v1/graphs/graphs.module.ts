import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { CapabilitiesController } from './controllers/capabilities.controller';
import { McpController } from './controllers/mcp.controller';
import { WorkflowsController } from './controllers/workflows.controller';
import { CallBroker } from './services/call-broker.service';
import { CapabilitiesService } from './services/capabilities.service';
import { GraphExecutorService } from './services/graph-executor.service';
import { McpServerService } from './services/mcp-server.service';
import { TaskBoardBroker } from './services/task-board.broker';
import { WorkflowStoreService } from './services/workflow-store.service';
import { WorkflowTitleBackfillService } from './services/workflow-title-backfill.service';

/**
 * Workflow graphs (M3): the YAML workflow library, the ported graph core
 * (validation + topo order in `utils/`), and the DAG fan-out executor that
 * drives the M2 agent adapters as a team. Graph definitions live in
 * `*.geniro.yaml` files (source of truth); SQLite keeps runtime/history rows
 * only (`runs` / `items` / `node_state`). The store is provided via a factory
 * because its options bag is a test seam, not a DI token.
 *
 * The per-CLI capability probes this module reads (`ClaudeProbeService`,
 * `CursorProbeService`) are NOT provided here: each lives beside the adapter it
 * drives and is exported by {@link AgentsModule}, which this module imports.
 */
@Module({
  imports: [AgentsModule],
  controllers: [WorkflowsController, McpController, CapabilitiesController],
  providers: [
    {
      provide: WorkflowStoreService,
      useFactory: () => new WorkflowStoreService(),
    },
    CapabilitiesService,
    GraphExecutorService,
    CallBroker,
    McpServerService,
    TaskBoardBroker,
    WorkflowTitleBackfillService,
  ],
  // `GraphExecutorService` is exported for `TasksModule`, whose cards may name
  // a workflow instead of an agent — the graph twin of the `ChatService` export
  // that module already borrows, and running the same way: tasks import graphs,
  // graphs never import tasks. `TaskBoardBroker` crosses the same way: the
  // tasks module installs the board behind it, and the MCP host here serves it.
  exports: [
    WorkflowStoreService,
    WorkflowTitleBackfillService,
    GraphExecutorService,
    TaskBoardBroker,
  ],
})
export class GraphsModule {}

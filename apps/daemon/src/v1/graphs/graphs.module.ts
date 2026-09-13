import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { CapabilitiesController } from './controllers/capabilities.controller';
import { McpController } from './controllers/mcp.controller';
import { WorkflowsController } from './controllers/workflows.controller';
import { CallBroker } from './services/call-broker.service';
import { CapabilitiesService } from './services/capabilities.service';
import { GraphExecutorService } from './services/graph-executor.service';
import { McpServerService } from './services/mcp-server.service';
import { RunWorkflowService } from './services/run-workflow.service';
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
    WorkflowTitleBackfillService,
    RunWorkflowService,
  ],
  // `GraphExecutorService` is exported for `TasksModule`, whose cards may name
  // a workflow instead of an agent — the graph twin of the `ChatService` export
  // that module already borrows, and running the same way: tasks import graphs,
  // graphs never import tasks.
  // `RunWorkflowService` is exported for every reader of an EXISTING run's
  // graph outside this module (the handoff, a task's settle): a run's workflow
  // is its snapshot, and reading the library there is how an edit would reach
  // a run it must not.
  exports: [
    WorkflowStoreService,
    WorkflowTitleBackfillService,
    GraphExecutorService,
    RunWorkflowService,
  ],
})
export class GraphsModule {}

import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { ConfigDirPinService } from '../agents/services/config-dir-pin.service';
import { CapabilitiesController } from './controllers/capabilities.controller';
import { WorkflowsController } from './controllers/workflows.controller';
import { CallBroker } from './services/call-broker.service';
import { CapabilitiesService } from './services/capabilities.service';
import { GraphExecutorService } from './services/graph-executor.service';
import { HostWakeGraphDelivery } from './services/host-wake-graph-delivery.service';
import { MonitorGraphDelivery } from './services/monitor-graph-delivery.service';
import { PoolCooldowns } from './services/pool-cooldowns.store';
import { RunWorkflowService } from './services/run-workflow.service';
import { TaskBoardBroker } from './services/task-board.broker';
import { WorkflowActionsService } from './services/workflow-actions.service';
import { WorkflowChangeService } from './services/workflow-change.service';
import { WorkflowChatService } from './services/workflow-chat.service';
import { WorkflowProposalService } from './services/workflow-proposal.service';
import { WorkflowStoreService } from './services/workflow-store.service';

/**
 * Workflow graphs (M3): the YAML workflow library, the ported graph core
 * (validation + topo order in `utils/`), and the DAG fan-out executor that
 * drives the M2 agent adapters as a team. Graph definitions live in
 * `*.geniro.yaml` files (source of truth); SQLite keeps runtime/history rows
 * only (`runs` / `items` / `node_state`). The store is provided via a factory
 * because its options bag is a test seam, not a DI token.
 *
 * No per-CLI probe is provided or read here: each CLI's probe belongs to its
 * own adapter, and this module reaches every adapter through the
 * `AgentAdapterRegistry` that {@link AgentsModule} exports.
 */
@Module({
  imports: [AgentsModule],
  controllers: [WorkflowsController, CapabilitiesController],
  providers: [
    {
      provide: WorkflowStoreService,
      useFactory: () => new WorkflowStoreService(),
    },
    CapabilitiesService,
    MonitorGraphDelivery,
    HostWakeGraphDelivery,
    {
      // One record for the daemon: a limit belongs to an account, whichever
      // run met it.
      provide: PoolCooldowns,
      useFactory: (pins: ConfigDirPinService) =>
        new PoolCooldowns(
          (agent, cwd) => pins.forRun(agent, cwd)?.effective ?? null,
        ),
      inject: [ConfigDirPinService],
    },
    GraphExecutorService,
    CallBroker,
    TaskBoardBroker,
    RunWorkflowService,
    WorkflowChatService,
    WorkflowChangeService,
    WorkflowActionsService,
    WorkflowProposalService,
  ],
  // `GraphExecutorService` is exported for `TasksModule`, whose cards may name
  // a workflow instead of an agent — the graph twin of the `ChatService` export
  // that module already borrows, and running the same way: tasks import graphs,
  // graphs never import tasks. `TaskBoardBroker` crosses the same way: the
  // tasks module installs the board behind it, and the MCP host in `McpModule`
  // serves it. `CallBroker` is exported for that host too: the call tools are
  // the MCP face of the call runtime, which stays here.
  // `RunWorkflowService` is exported for every reader of an EXISTING run's
  // graph outside this module (the handoff): a run's workflow is its snapshot,
  // and reading the library there is how an edit would reach a run it must not.
  // `WorkflowProposalService` is exported for the MCP host's `propose_workflow`
  // and for `main.ts`'s boot rehydration of standing proposal cards.
  exports: [
    WorkflowStoreService,
    GraphExecutorService,
    CallBroker,
    TaskBoardBroker,
    RunWorkflowService,
    WorkflowChangeService,
    WorkflowProposalService,
  ],
})
export class GraphsModule {}

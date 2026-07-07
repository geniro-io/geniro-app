import { Module } from '@nestjs/common';

import { CallTokenRegistry } from '../../auth/call-token.registry';
import { RUNTIME_TOKEN, type RuntimeInfo } from '../../auth/runtime';
import { CursorAdapter } from '../agents/adapters/cursor/cursor.adapter';
import { AgentsModule } from '../agents/agents.module';
import { ProcessRegistry } from '../agents/services/process-registry';
import { CapabilitiesController } from './controllers/capabilities.controller';
import { McpController } from './controllers/mcp.controller';
import { WorkflowsController } from './controllers/workflows.controller';
import { CallBroker } from './services/call-broker.service';
import { CursorProbeService } from './services/cursor-probe.service';
import { GraphExecutorService } from './services/graph-executor.service';
import { McpServerService } from './services/mcp-server.service';
import { WorkflowStoreService } from './services/workflow-store.service';

/**
 * Workflow graphs (M3): the YAML workflow library, the ported graph core
 * (validation + topo order in `utils/`), and the DAG fan-out executor that
 * drives the M2 agent adapters as a team. Graph definitions live in
 * `*.geniro.yaml` files (source of truth); SQLite keeps runtime/history rows
 * only (`runs` / `items` / `node_state`). The store is provided via a factory
 * because its options bag is a test seam, not a DI token.
 */
@Module({
  imports: [AgentsModule],
  controllers: [WorkflowsController, McpController, CapabilitiesController],
  providers: [
    {
      provide: WorkflowStoreService,
      useFactory: () => new WorkflowStoreService(),
    },
    {
      // Factory because the trailing options bag is a test seam, not a DI token
      // (same pattern as the adapters and the store).
      provide: CursorProbeService,
      useFactory: (
        adapter: CursorAdapter,
        tokens: CallTokenRegistry,
        processes: ProcessRegistry,
        runtime: RuntimeInfo,
      ) => new CursorProbeService(adapter, tokens, processes, runtime),
      inject: [
        CursorAdapter,
        CallTokenRegistry,
        ProcessRegistry,
        RUNTIME_TOKEN,
      ],
    },
    GraphExecutorService,
    CallBroker,
    McpServerService,
  ],
  exports: [WorkflowStoreService],
})
export class GraphsModule {}

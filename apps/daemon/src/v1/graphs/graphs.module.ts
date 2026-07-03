import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { WorkflowsController } from './controllers/workflows.controller';
import { GraphExecutorService } from './services/graph-executor.service';
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
  controllers: [WorkflowsController],
  providers: [
    {
      provide: WorkflowStoreService,
      useFactory: () => new WorkflowStoreService(),
    },
    GraphExecutorService,
  ],
})
export class GraphsModule {}

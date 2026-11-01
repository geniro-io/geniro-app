import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { ConfigDirPinService } from '../agents/services/config-dir-pin.service';
import { MemoryModule } from '../memory/memory.module';
import { ProjectsModule } from '../projects/projects.module';
import { CapabilitiesController } from './controllers/capabilities.controller';
import { TeamsController } from './controllers/teams.controller';
import { TeamChangeLogDao } from './dao/team-change-log.dao';
import { CallBroker } from './services/call-broker.service';
import { CapabilitiesService } from './services/capabilities.service';
import { GraphExecutorService } from './services/graph-executor.service';
import { HostWakeGraphDelivery } from './services/host-wake-graph-delivery.service';
import { InstructionSizesService } from './services/instruction-sizes.service';
import { MonitorGraphDelivery } from './services/monitor-graph-delivery.service';
import { PoolCooldowns } from './services/pool-cooldowns.store';
import { RunTeamService } from './services/run-team.service';
import { StageService } from './services/stage.service';
import { StageWakeService } from './services/stage-wake.service';
import { TaskBoardBroker } from './services/task-board.broker';
import { TeamActionsService } from './services/team-actions.service';
import { TeamAnalysisService } from './services/team-analysis.service';
import { TeamChangeService } from './services/team-change.service';
import { TeamChangeLogService } from './services/team-change-log.service';
import { TeamChatService } from './services/team-chat.service';
import { TeamProposalService } from './services/team-proposal.service';
import { TeamStoreService } from './services/team-store.service';

/**
 * Team graphs (M3): the YAML team library, the ported graph core
 * (validation + topo order in `utils/`), and the DAG fan-out executor that
 * drives the M2 agent adapters as a team. Graph definitions live in
 * `*.team.yaml` files (source of truth); SQLite keeps runtime/history rows
 * only (`runs` / `items` / `node_state`). The store is provided via a factory
 * because its options bag is a test seam, not a DI token.
 *
 * No per-CLI probe is provided or read here: each CLI's probe belongs to its
 * own adapter, and this module reaches every adapter through the
 * `AgentAdapterRegistry` that {@link AgentsModule} exports.
 */
@Module({
  imports: [AgentsModule, MemoryModule, ProjectsModule],
  controllers: [TeamsController, CapabilitiesController],
  providers: [
    {
      provide: TeamStoreService,
      useFactory: () => new TeamStoreService(),
    },
    CapabilitiesService,
    InstructionSizesService,
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
    RunTeamService,
    StageService,
    StageWakeService,
    TeamChatService,
    TeamAnalysisService,
    TeamChangeService,
    TeamChangeLogDao,
    TeamChangeLogService,
    TeamActionsService,
    TeamProposalService,
  ],
  // `GraphExecutorService` is exported for `TasksModule`, whose cards may name
  // a team instead of an agent — the graph twin of the `ChatService` export
  // that module already borrows, and running the same way: tasks import graphs,
  // graphs never import tasks. `TaskBoardBroker` crosses the same way: the
  // tasks module installs the board behind it, and the MCP host in `McpModule`
  // serves it. `CallBroker` is exported for that host too: the call tools are
  // the MCP face of the call runtime, which stays here.
  // `RunTeamService` is exported for every reader of an EXISTING run's
  // graph outside this module (the handoff): a run's team is its snapshot,
  // and reading the library there is how an edit would reach a run it must not.
  // `TeamProposalService` is exported for the MCP host's `propose_team`
  // and for `main.ts`'s boot rehydration of standing proposal cards.
  // `TeamChangeLogService` is exported for the stats module's version
  // restore, which writes the library too, and for its team history read.
  exports: [
    TeamStoreService,
    GraphExecutorService,
    CallBroker,
    TaskBoardBroker,
    RunTeamService,
    StageService,
    TeamChangeService,
    TeamChangeLogService,
    TeamProposalService,
  ],
})
export class TeamsModule {}

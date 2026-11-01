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
import { TeamExecutorService } from './services/team-executor.service';
import { TeamLiveWorkSources } from './services/team-live-work.service';
import { TeamProposalService } from './services/team-proposal.service';
import { TeamStoreService } from './services/team-store.service';

/**
 * Teams: the YAML team library, its validation in `utils/`, and the executor
 * that drives the agent adapters as a team. Team definitions live in
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
    TeamLiveWorkSources,
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
    TeamExecutorService,
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
  // `TeamExecutorService` is exported for `TasksModule`, whose cards may name
  // a team instead of an agent — the team twin of the `ChatService` export
  // that module already borrows, and running the same way: tasks import teams,
  // teams never import tasks. `TaskBoardBroker` crosses the same way: the
  // tasks module installs the board behind it, and the MCP host in `McpModule`
  // serves it. `CallBroker` is exported for that host too: the call tools are
  // the MCP face of the call runtime, which stays here.
  // `RunTeamService` is exported for every reader of an EXISTING run's
  // team outside this module (the handoff): a run's team is its snapshot,
  // and reading the library there is how an edit would reach a run it must not.
  // `TeamProposalService` is exported for the MCP host's `propose_team`
  // and for `main.ts`'s boot rehydration of standing proposal cards.
  // `TeamChangeLogService` is exported for the stats module's version
  // restore, which writes the library too, and for its team history read.
  exports: [
    TeamStoreService,
    TeamExecutorService,
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

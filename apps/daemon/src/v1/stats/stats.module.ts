import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { ProjectsModule } from '../projects/projects.module';
import { TeamsModule } from '../teams/teams.module';
import { StatsController } from './controllers/stats.controller';
import { LineBaselineDao } from './dao/line-baseline.dao';
import { TeamRecommendationDao } from './dao/team-recommendation.dao';
import { TeamVersionDao } from './dao/team-version.dao';
import { UsageActivityDao } from './dao/usage-activity.dao';
import { UsageEventDao } from './dao/usage-event.dao';
import { RecommendationLedgerService } from './services/recommendation-ledger.service';
import { RunOutcomeLedgerService } from './services/run-outcome-ledger.service';
import { StatsService } from './services/stats.service';
import { TeamHistoryService } from './services/team-history.service';
import { TeamLedgerService } from './services/team-ledger.service';
import { TeamVersionsService } from './services/team-versions.service';
import { UsageActivityRecorderService } from './services/usage-activity-recorder.service';
import { UsageBackfillService } from './services/usage-backfill.service';
import { UsageEventBus } from './services/usage-events.bus';
import { UsageRecorderService } from './services/usage-recorder.service';

/**
 * The usage ledger and the stats it answers.
 *
 * It imports `AgentsModule` (for the event bus and the run/item/member-state DAOs) and
 * must not be imported BY it. That direction is deliberate and cycle-free, and
 * it mirrors `DiagnosticsModule`: this module OBSERVES the agent plane and never
 * drives it, so nothing in `v1/agents` depends on it. `TeamsModule` is imported
 * for the library store alone (the versions table names which version the saved
 * team is), in the same direction. The one boot dependency runs the other way:
 * `main.ts` awaits `TeamLedgerService.sweep()` before listen.
 *
 * The one thing it deliberately does NOT hook is the run teardown. A chat
 * delete destroys that run's `runs` / `items` / `node_state` rows; the ledger is
 * left standing, which is the whole reason it exists as a separate table rather
 * than as a query over the transcript.
 */
@Module({
  imports: [AgentsModule, TeamsModule, ProjectsModule],
  controllers: [StatsController],
  providers: [
    UsageEventDao,
    UsageActivityDao,
    LineBaselineDao,
    UsageEventBus,
    StatsService,
    UsageRecorderService,
    UsageActivityRecorderService,
    UsageBackfillService,
    RunOutcomeLedgerService,
    TeamVersionDao,
    TeamLedgerService,
    TeamVersionsService,
    TeamRecommendationDao,
    RecommendationLedgerService,
    TeamHistoryService,
  ],
  // The bus, and the team history. The WS gateway announces each recorded
  // turn so an open Stats page can refresh, and the MCP host's analysis reader
  // answers a team's history from these ledgers — the same direction as
  // everything else here: both sit above this module, which observes nothing
  // above it.
  exports: [UsageEventBus, TeamHistoryService],
})
export class StatsModule {}

import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { StatsController } from './controllers/stats.controller';
import { UsageEventDao } from './dao/usage-event.dao';
import { StatsService } from './services/stats.service';
import { UsageBackfillService } from './services/usage-backfill.service';
import { UsageEventBus } from './services/usage-events.bus';
import { UsageRecorderService } from './services/usage-recorder.service';

/**
 * The usage ledger and the stats it answers.
 *
 * It imports `AgentsModule` (for the event bus and the run/item/node DAOs) and
 * must not be imported BY it. That direction is deliberate and cycle-free, and it
 * mirrors `DiagnosticsModule`: this module OBSERVES the agent plane and never
 * drives it, so nothing in `v1/agents` depends on it — a daemon built without
 * this module behaves identically, minus the history.
 *
 * The one thing it deliberately does NOT hook is the run teardown. A chat
 * delete destroys that run's `runs` / `items` / `node_state` rows; the ledger is
 * left standing, which is the whole reason it exists as a separate table rather
 * than as a query over the transcript.
 */
@Module({
  imports: [AgentsModule],
  controllers: [StatsController],
  providers: [
    UsageEventDao,
    UsageEventBus,
    StatsService,
    UsageRecorderService,
    UsageBackfillService,
  ],
  // The bus alone. The WS gateway announces each recorded turn so an open Stats
  // page can refresh — the same direction as everything else here: the channel
  // observes this module, this module observes nothing above it.
  exports: [UsageEventBus],
})
export class StatsModule {}

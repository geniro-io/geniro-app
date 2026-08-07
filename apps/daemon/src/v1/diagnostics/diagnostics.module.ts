import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { DiagnosticsController } from './controllers/diagnostics.controller';
import { DebugLogService } from './services/debug-log.service';
import { DiagnosticsReportService } from './services/diagnostics-report.service';

/**
 * The debug surface: the injectable face of the module-scope debug sink, the
 * transcript-plane subscription that feeds it, and the diagnostics report.
 *
 * It imports `AgentsModule` (for the event bus, the registries and the run
 * DAO) and is imported by `NotificationsModule`, which fans live entries out
 * over the existing `/ws` channel. That direction is deliberate and cycle-free:
 * diagnostics OBSERVES the agent plane and never drives it, so nothing in
 * `v1/agents` depends on this module — a daemon built without it behaves
 * identically, minus the log.
 */
@Module({
  imports: [AgentsModule],
  controllers: [DiagnosticsController],
  providers: [DebugLogService, DiagnosticsReportService],
  exports: [DebugLogService],
})
export class DiagnosticsModule {}

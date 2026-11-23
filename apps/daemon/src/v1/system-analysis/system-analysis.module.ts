import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { LessonsModule } from '../lessons/lessons.module';
import { MemoryModule } from '../memory/memory.module';
import { ProjectsModule } from '../projects/projects.module';
import { StatsModule } from '../stats/stats.module';
import { TasksModule } from '../tasks/tasks.module';
import { SystemAnalysesController } from './controllers/system-analyses.controller';
import { SystemAnalysisService } from './services/system-analysis.service';
import { SystemAnalysisApplyService } from './services/system-analysis-apply.service';
import { SystemAnalysisEventBus } from './services/system-analysis-events.bus';
import { SystemAnalysisHistoryService } from './services/system-analysis-history.service';
import { SystemAnalysisStartsService } from './services/system-analysis-starts.service';
import { SystemDigestService } from './services/system-digest.service';

/**
 * Settings' system analysis: a period's troubled threads read as one digest,
 * an analysis chat over them, and the report's button that files its geniro
 * items as board cards.
 *
 * It sits above Agents, Stats, Lessons and Tasks and imports them one way —
 * none of them imports it back. The MCP module imports it for the history a
 * system analysis reads, and the notifications gateway for its change bus.
 */
@Module({
  imports: [
    AgentsModule,
    StatsModule,
    LessonsModule,
    TasksModule,
    ProjectsModule,
    MemoryModule,
  ],
  controllers: [SystemAnalysesController],
  providers: [
    SystemDigestService,
    SystemAnalysisService,
    SystemAnalysisApplyService,
    SystemAnalysisStartsService,
    SystemAnalysisHistoryService,
    SystemAnalysisEventBus,
  ],
  exports: [SystemAnalysisHistoryService, SystemAnalysisEventBus],
})
export class SystemAnalysisModule {}

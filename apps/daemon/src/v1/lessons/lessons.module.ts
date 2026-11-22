import { Module } from '@nestjs/common';

import { DesktopOnlyGuard } from '../../auth/desktop-only.guard';
import { AgentsModule } from '../agents/agents.module';
import { BackgroundJobsModule } from '../background-jobs/background-jobs.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { MemoryModule } from '../memory/memory.module';
import { ProjectsModule } from '../projects/projects.module';
import { UsageEventDao } from '../stats/dao/usage-event.dao';
import { TeamsModule } from '../teams/teams.module';
import { LessonSegmentsController } from './controllers/lesson-segments.controller';
import { LessonsController } from './controllers/lessons.controller';
import { LessonsConfigController } from './controllers/lessons-config.controller';
import { ThreadLessonsController } from './controllers/thread-lessons.controller';
import { LessonProposalDao } from './dao/lesson-proposal.dao';
import { LessonSegmentDao } from './dao/lesson-segment.dao';
import { LessonAutoRunner } from './services/lesson-auto-runner.service';
import { LessonBackgroundJobSource } from './services/lesson-background-jobs.source';
import { LessonCheckService } from './services/lesson-check.service';
import { LessonEstimateService } from './services/lesson-estimate.service';
import { LessonFilingService } from './services/lesson-filing.service';
import { LessonProposalService } from './services/lesson-proposal.service';
import { LessonReflectionService } from './services/lesson-reflection.service';
import { LessonRowWriter } from './services/lesson-row.writer';
import { LessonSegmentService } from './services/lesson-segment.service';
import { LessonSpendService } from './services/lesson-spend.service';
import { LessonsConfigService } from './services/lessons-config.service';
import { LessonsEventBus } from './services/lessons-events.bus';

/**
 * Lessons (`v1/lessons`): archiving a thread queues its stretch with a
 * learning signal for a hidden reflection (`LessonAutoRunner`), on the CLI,
 * profile and model the settings name; its lessons are filed into searchable
 * shared memory, after an optional second-model check.
 *
 * `lesson_proposals` sits outside run teardown; `lesson_segments` goes with
 * its run (`LessonReflectionService`). It provides the usage ledger's DAO it
 * reads rather than importing `StatsModule`; `McpModule` imports it for
 * `propose_lessons`, and the notifications gateway for `lessons_changed`.
 * `TeamsModule` comes in for the team's own lessons setting, the team-run
 * delete and a lesson saved into a member's instructions; `KnowledgeModule`
 * for a lesson saved as a knowledge document. Neither imports this module.
 * `BackgroundJobsModule` comes in to register its runs as background jobs
 * (`LessonBackgroundJobSource`); it imports nothing back.
 */
@Module({
  imports: [
    AgentsModule,
    BackgroundJobsModule,
    KnowledgeModule,
    MemoryModule,
    ProjectsModule,
    TeamsModule,
  ],
  controllers: [
    ThreadLessonsController,
    LessonsController,
    LessonSegmentsController,
    LessonsConfigController,
  ],
  providers: [
    DesktopOnlyGuard,
    LessonProposalDao,
    LessonSegmentDao,
    UsageEventDao,
    LessonsConfigService,
    LessonsEventBus,
    LessonRowWriter,
    LessonEstimateService,
    LessonReflectionService,
    LessonSegmentService,
    LessonFilingService,
    LessonCheckService,
    LessonAutoRunner,
    LessonSpendService,
    LessonProposalService,
    LessonBackgroundJobSource,
  ],
  exports: [LessonFilingService, LessonCheckService, LessonsEventBus],
})
export class LessonsModule {}

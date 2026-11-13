import { Module } from '@nestjs/common';

import { DesktopOnlyGuard } from '../../auth/desktop-only.guard';
import { AgentsModule } from '../agents/agents.module';
import { MemoryModule } from '../memory/memory.module';
import { ProjectsModule } from '../projects/projects.module';
import { UsageEventDao } from '../stats/dao/usage-event.dao';
import { TasksModule } from '../tasks/tasks.module';
import { TeamsModule } from '../teams/teams.module';
import { LessonOffersController } from './controllers/lesson-offers.controller';
import { LessonsController } from './controllers/lessons.controller';
import { LessonsConfigController } from './controllers/lessons-config.controller';
import { ThreadLessonsController } from './controllers/thread-lessons.controller';
import { LessonProposalDao } from './dao/lesson-proposal.dao';
import { LessonSegmentDao } from './dao/lesson-segment.dao';
import { LessonEstimateService } from './services/lesson-estimate.service';
import { LessonFilingService } from './services/lesson-filing.service';
import { LessonOffersService } from './services/lesson-offers.service';
import { LessonPendingDeleteService } from './services/lesson-pending-delete.service';
import { LessonProposalService } from './services/lesson-proposal.service';
import { LessonReflectionService } from './services/lesson-reflection.service';
import { LessonRowWriter } from './services/lesson-row.writer';
import { LessonSegmentService } from './services/lesson-segment.service';
import { LessonsConfigService } from './services/lessons-config.service';
import { LessonsEventBus } from './services/lessons-events.bus';

/**
 * Lessons (`v1/lessons`): a closed stretch of a thread with a learning signal
 * is offered for a hidden reflection, which proposes lessons the user saves
 * to the shared memory.
 *
 * `lesson_proposals` sits outside run teardown; `lesson_segments` goes with
 * its run (`LessonReflectionService`). It provides the usage ledger's DAO it
 * reads rather than importing `StatsModule`; `McpModule` imports it for
 * `propose_lessons`, and the notifications gateway for `lessons_changed`.
 * `TasksModule` and `TeamsModule` come in for the card moves, the team's own
 * lessons setting and the team-run delete; neither imports this module.
 */
@Module({
  imports: [
    AgentsModule,
    MemoryModule,
    ProjectsModule,
    TasksModule,
    TeamsModule,
  ],
  controllers: [
    ThreadLessonsController,
    LessonsController,
    LessonOffersController,
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
    LessonOffersService,
    LessonPendingDeleteService,
    LessonFilingService,
    LessonProposalService,
  ],
  exports: [LessonFilingService, LessonsEventBus],
})
export class LessonsModule {}

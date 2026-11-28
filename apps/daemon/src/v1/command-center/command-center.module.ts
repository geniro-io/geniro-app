import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { LessonsModule } from '../lessons/lessons.module';
import { MemoryModule } from '../memory/memory.module';
import { ProjectsModule } from '../projects/projects.module';
import { SharesModule } from '../shares/shares.module';
import { TasksModule } from '../tasks/tasks.module';
import { TeamsModule } from '../teams/teams.module';
import { CommandCenterController } from './controllers/command-center.controller';
import { CommandCenterDoneDismissalDao } from './dao/command-center-done-dismissal.dao';
import { CommandCenterNoticeDao } from './dao/command-center-notice.dao';
import { CommandCenterRosterDao } from './dao/command-center-roster.dao';
import { CommandCenterThreadStartDao } from './dao/command-center-thread-start.dao';
import { CommandCenterTimelineDao } from './dao/command-center-timeline.dao';
import { CommandCenterService } from './services/command-center.service';
import { CommandCenterChatService } from './services/command-center-chat.service';
import { CommandCenterEventBus } from './services/command-center-events.bus';
import { CommandCenterEventsService } from './services/command-center-events.service';
import { CommandCenterNoticesService } from './services/command-center-notices.service';
import { CommandCenterNotifyService } from './services/command-center-notify.service';
import { CommandCenterOpsService } from './services/command-center-ops.service';
import { CommandCenterStartsService } from './services/command-center-starts.service';
import { CommandCenterTimelineService } from './services/command-center-timeline.service';
import { CommandCenterWaitingService } from './services/command-center-waiting.service';
import { ManagerAnnouncementsService } from './services/manager-announcements.service';

/**
 * The command center: one board over every active thread, and the manager
 * chat that watches, messages and starts them.
 *
 * It sits above Agents, Teams, Tasks and Projects and imports them one way —
 * none of them imports it back. What they must reach of it is installed into
 * them at boot instead: the manager's brief into `ChatService`
 * (`useCommandCenter`), and its tools' operations into `CommandCenterOpsBroker`.
 * `CommandCenterEventBus` is exported for `NotificationsModule`, the one
 * fan-out subscriber, on `TaskEventBus`'s terms.
 */
@Module({
  imports: [
    AgentsModule,
    TeamsModule,
    TasksModule,
    ProjectsModule,
    MemoryModule,
    LessonsModule,
    KnowledgeModule,
    SharesModule,
  ],
  controllers: [CommandCenterController],
  providers: [
    CommandCenterDoneDismissalDao,
    CommandCenterNoticeDao,
    CommandCenterRosterDao,
    CommandCenterThreadStartDao,
    CommandCenterTimelineDao,
    CommandCenterEventBus,
    CommandCenterService,
    CommandCenterChatService,
    CommandCenterStartsService,
    CommandCenterOpsService,
    CommandCenterEventsService,
    CommandCenterNotifyService,
    CommandCenterTimelineService,
    CommandCenterWaitingService,
    CommandCenterNoticesService,
    ManagerAnnouncementsService,
  ],
  exports: [CommandCenterEventBus],
})
export class CommandCenterModule {}

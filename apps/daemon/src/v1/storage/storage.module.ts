import { EntityManager } from '@mikro-orm/sqlite';
import { Module } from '@nestjs/common';

import { DesktopOnlyGuard } from '../../auth/desktop-only.guard';
import { AgentsModule } from '../agents/agents.module';
import { RunDao } from '../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../agents/services/agent-adapter.registry';
import { AgentSessionRegistry } from '../agents/services/agent-session.registry';
import { ChatService } from '../agents/services/chat.service';
import { ProcessRegistry } from '../agents/services/process-registry';
import { TaskDao } from '../tasks/dao/task.dao';
import { StorageController } from './controllers/storage.controller';
import { StorageService } from './services/storage.service';

/**
 * Settings → Storage (`v1/storage`): measures the data folder and runs the
 * clean-ups. It deletes chats only through `ChatService`, whose sweep is the
 * one teardown path, so it imports `AgentsModule` and nothing imports it.
 */
@Module({
  imports: [AgentsModule],
  controllers: [StorageController],
  providers: [
    DesktopOnlyGuard,
    RunDao,
    TaskDao,
    {
      provide: StorageService,
      inject: [
        EntityManager,
        ChatService,
        ProcessRegistry,
        AgentSessionRegistry,
        AgentAdapterRegistry,
        RunDao,
        TaskDao,
      ],
      useFactory: (
        em: EntityManager,
        chats: ChatService,
        registry: ProcessRegistry,
        sessions: AgentSessionRegistry,
        adapters: AgentAdapterRegistry,
        runDao: RunDao,
        taskDao: TaskDao,
      ) =>
        new StorageService(
          em,
          chats,
          registry,
          sessions,
          adapters,
          runDao,
          taskDao,
        ),
    },
  ],
})
export class StorageModule {}

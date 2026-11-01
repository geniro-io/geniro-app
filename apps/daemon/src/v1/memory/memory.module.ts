import { Module } from '@nestjs/common';

import { DesktopOnlyGuard } from '../../auth/desktop-only.guard';
import { NodeStateDao } from '../agents/dao/node-state.dao';
import { RunDao } from '../agents/dao/run.dao';
import { ProjectsModule } from '../projects/projects.module';
import { MemoriesController } from './controllers/memories.controller';
import { MemoryConfigController } from './controllers/memory-config.controller';
import { MemoryDao } from './dao/memory.dao';
import { MemoryService } from './services/memory.service';
import { MemoryEventBus } from './services/memory-events.bus';
import { MemoryTextIndexService } from './services/memory-text-index.service';

/**
 * The memory every agent shares (`v1/memory`), read and written through
 * geniro's own MCP tools.
 *
 * Its rows sit outside run teardown: a memory outlives the chat that wrote it.
 * It provides the run and member-state DAOs it reads rather than importing
 * `AgentsModule`, and imports only `ProjectsModule`, so `AgentsModule`,
 * `TeamsModule`, `McpModule` and `NotificationsModule` can import it without
 * a cycle.
 */
@Module({
  imports: [ProjectsModule],
  controllers: [MemoryConfigController, MemoriesController],
  providers: [
    DesktopOnlyGuard,
    MemoryDao,
    RunDao,
    NodeStateDao,
    MemoryService,
    MemoryEventBus,
    MemoryTextIndexService,
  ],
  exports: [MemoryService, MemoryEventBus, MemoryTextIndexService],
})
export class MemoryModule {}

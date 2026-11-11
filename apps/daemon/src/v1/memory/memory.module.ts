import { Module } from '@nestjs/common';

import { DesktopOnlyGuard } from '../../auth/desktop-only.guard';
import { ItemDao } from '../agents/dao/item.dao';
import { NodeStateDao } from '../agents/dao/node-state.dao';
import { RunDao } from '../agents/dao/run.dao';
import { ProjectsModule } from '../projects/projects.module';
import { MemoriesController } from './controllers/memories.controller';
import { MemoryConfigController } from './controllers/memory-config.controller';
import { MemoryDao } from './dao/memory.dao';
import { MemoryUsageDao } from './dao/memory-usage.dao';
import { MemoryService } from './services/memory.service';
import { MemoryEventBus } from './services/memory-events.bus';
import { MemoryReviewService } from './services/memory-review.service';
import { MemoryTextIndexService } from './services/memory-text-index.service';
import { MemoryUsageService } from './services/memory-usage.service';
import { MemoryUsageBackfillService } from './services/memory-usage-backfill.service';

/**
 * The memory every agent shares (`v1/memory`), read and written through
 * geniro's own MCP tools.
 *
 * Its rows sit outside run teardown: a memory outlives the chat that wrote it.
 * It provides the run, item and member-state DAOs it reads rather than importing
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
    MemoryUsageDao,
    RunDao,
    NodeStateDao,
    ItemDao,
    MemoryService,
    MemoryEventBus,
    MemoryReviewService,
    MemoryTextIndexService,
    MemoryUsageService,
    MemoryUsageBackfillService,
  ],
  exports: [
    MemoryService,
    MemoryEventBus,
    MemoryReviewService,
    MemoryTextIndexService,
    MemoryUsageBackfillService,
  ],
})
export class MemoryModule {}

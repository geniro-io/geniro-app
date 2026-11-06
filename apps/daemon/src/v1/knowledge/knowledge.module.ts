import { Module } from '@nestjs/common';

import { DesktopOnlyGuard } from '../../auth/desktop-only.guard';
import { MemoryModule } from '../memory/memory.module';
import { ProjectsModule } from '../projects/projects.module';
import { KnowledgeController } from './controllers/knowledge.controller';
import { KnowledgeConfigController } from './controllers/knowledge-config.controller';
import { KnowledgeDocumentDao } from './dao/knowledge-document.dao';
import { KnowledgeRevisionDao } from './dao/knowledge-revision.dao';
import { KnowledgeService } from './services/knowledge.service';
import { KnowledgeEventBus } from './services/knowledge-events.bus';
import { KnowledgeProjectRemovalService } from './services/knowledge-project-removal.service';
import { KnowledgeTextIndexService } from './services/knowledge-text-index.service';

/**
 * The knowledge store (`v1/knowledge`): Markdown documents filed in a project,
 * a team or Global, read by agents through geniro's own MCP tools.
 *
 * Its rows sit outside run teardown. It imports only `MemoryModule` (who a run
 * and a caller are) and `ProjectsModule`, so `AgentsModule`, `TeamsModule`,
 * `McpModule` and `NotificationsModule` can import it without a cycle.
 */
@Module({
  imports: [MemoryModule, ProjectsModule],
  controllers: [KnowledgeConfigController, KnowledgeController],
  providers: [
    DesktopOnlyGuard,
    KnowledgeDocumentDao,
    KnowledgeRevisionDao,
    KnowledgeService,
    KnowledgeEventBus,
    KnowledgeProjectRemovalService,
    KnowledgeTextIndexService,
  ],
  exports: [KnowledgeService, KnowledgeEventBus, KnowledgeTextIndexService],
})
export class KnowledgeModule {}

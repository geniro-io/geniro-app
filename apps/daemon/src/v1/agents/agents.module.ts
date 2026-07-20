import { join } from 'node:path';

import { Module } from '@nestjs/common';

import { environment } from '../../environments';
import { ClaudeAdapter } from './adapters/claude/claude.adapter';
import { CursorAdapter } from './adapters/cursor/cursor.adapter';
import { ChatController } from './controllers/chat.controller';
import { SkillsController } from './controllers/skills.controller';
import { ItemDao } from './dao/item.dao';
import { NodeStateDao } from './dao/node-state.dao';
import { RunDao } from './dao/run.dao';
import { AgentEventBus } from './services/agent-events.bus';
import { ApprovalRegistry } from './services/approval-registry';
import { ChatService } from './services/chat.service';
import { CursorMcpMergeService } from './services/cursor-mcp-merge.service';
import { ProcessRegistry } from './services/process-registry';
import { SkillsService } from './services/skills.service';

/**
 * Single-agent chat (M2): the AgentAdapter subclasses, persistence DAOs, the in-proc
 * event bus, and the child-process registry. Entities are discovered globally
 * (mikro-orm config glob) and the EntityManager is provided app-wide by the
 * global MikroOrmModule, so no `forFeature` import is needed here. The adapters
 * are provided via factories because their constructor option bag is not a DI
 * token. `AgentEventBus` is exported so the notifications gateway can fan its
 * events out to per-run Socket.IO rooms.
 */
@Module({
  controllers: [ChatController, SkillsController],
  providers: [
    ChatService,
    // Factory because the options bag (homeDir) is a test seam, not a DI token.
    { provide: SkillsService, useFactory: () => new SkillsService() },
    AgentEventBus,
    ApprovalRegistry,
    ProcessRegistry,
    ItemDao,
    NodeStateDao,
    RunDao,
    {
      provide: ClaudeAdapter,
      // Per-turn --mcp-config files live under the daemon's own userData tmp
      // (never the OS-shared tmpdir) — they carry the per-run call token.
      useFactory: () =>
        new ClaudeAdapter({
          mcpConfigDir: join(environment.userDataDir, 'tmp'),
        }),
    },
    { provide: CursorAdapter, useFactory: () => new CursorAdapter() },
    {
      // Factory because the trailing options bag is a test seam, not a DI token.
      provide: CursorMcpMergeService,
      useFactory: (processes: ProcessRegistry) =>
        new CursorMcpMergeService(processes),
      inject: [ProcessRegistry],
    },
  ],
  exports: [
    AgentEventBus,
    ApprovalRegistry,
    ProcessRegistry,
    ItemDao,
    NodeStateDao,
    RunDao,
    ClaudeAdapter,
    CursorAdapter,
    CursorMcpMergeService,
  ],
})
export class AgentsModule {}

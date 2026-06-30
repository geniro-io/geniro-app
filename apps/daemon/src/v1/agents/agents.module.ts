import { Module } from '@nestjs/common';

import { AgentEventBus } from './agent-events.bus';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ClaudeExecutor } from './claude.adapter';
import { CursorExecutor } from './cursor.adapter';
import { ItemDao } from './dao/item.dao';
import { NodeStateDao } from './dao/node-state.dao';
import { RunDao } from './dao/run.dao';
import { ProcessRegistry } from './process-registry';

/**
 * Single-agent chat (M2): the Executor adapters, persistence DAOs, the in-proc
 * event bus, and the child-process registry. Entities are discovered globally
 * (mikro-orm config glob) and the EntityManager is provided app-wide by the
 * global MikroOrmModule, so no `forFeature` import is needed here. The adapters
 * are provided via factories because their constructor option bag is not a DI
 * token. `AgentEventBus` is exported so the notifications gateway can fan its
 * events out to per-run Socket.IO rooms.
 */
@Module({
  controllers: [ChatController],
  providers: [
    ChatService,
    AgentEventBus,
    ProcessRegistry,
    ItemDao,
    NodeStateDao,
    RunDao,
    { provide: ClaudeExecutor, useFactory: () => new ClaudeExecutor() },
    { provide: CursorExecutor, useFactory: () => new CursorExecutor() },
  ],
  exports: [AgentEventBus],
})
export class AgentsModule {}

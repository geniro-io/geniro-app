import { join } from 'node:path';

import { Logger, Module } from '@nestjs/common';

import { environment } from '../../environments';
import { ClaudeAdapter } from './adapters/claude/claude.adapter';
import { ClaudeProbeService } from './adapters/claude/claude-probe.service';
import { CursorAcpAdapter } from './adapters/cursor-acp/cursor-acp.adapter';
import { ChatController } from './controllers/chat.controller';
import { SkillsController } from './controllers/skills.controller';
import { ItemDao } from './dao/item.dao';
import { NodeStateDao } from './dao/node-state.dao';
import { RunDao } from './dao/run.dao';
import { AgentAdapterRegistry } from './services/agent-adapter.registry';
import { AgentEventBus } from './services/agent-events.bus';
import { ApprovalRegistry } from './services/approval-registry';
import { AttachmentStoreService } from './services/attachment-store.service';
import { ChatService } from './services/chat.service';
import { CursorMcpCleanupService } from './services/cursor-mcp-cleanup.service';
import { EffortsService } from './services/efforts.service';
import { ModelsService } from './services/models.service';
import { PartialStreamService } from './services/partial-stream.service';
import { ProcessRegistry } from './services/process-registry';
import { RunTeardownService } from './services/run-teardown.service';
import { SkillHarvestStore } from './services/skill-harvest.store';
import { SkillsService } from './services/skills.service';

/**
 * Single-agent chat (M2): the AgentAdapter subclasses, persistence DAOs, the in-proc
 * event bus, and the child-process registry. Entities are discovered globally
 * (mikro-orm config glob) and the EntityManager is provided app-wide by the
 * global MikroOrmModule, so no `forFeature` import is needed here. The adapters
 * are provided via factories because their constructor option bag is not a DI
 * token. `AgentEventBus` is exported so the notifications gateway can fan its
 * events out to per-run Socket.IO rooms.
 *
 * A CLI's own capability probe is provided here too — beside the adapter it
 * drives, not in the module that happens to consume its verdict — and exported,
 * so every consumer resolves the one instance whose per-launch verdict cache
 * makes the probe run once.
 */
@Module({
  controllers: [ChatController, SkillsController],
  providers: [
    ChatService,
    AgentAdapterRegistry,
    // Factories because the trailing options bags are test seams, not DI tokens.
    { provide: SkillHarvestStore, useFactory: () => new SkillHarvestStore() },
    {
      provide: CursorMcpCleanupService,
      useFactory: () => new CursorMcpCleanupService(),
    },
    {
      provide: AttachmentStoreService,
      useFactory: () => new AttachmentStoreService(),
    },
    {
      provide: SkillsService,
      useFactory: (
        harvest: SkillHarvestStore,
        adapters: AgentAdapterRegistry,
        processes: ProcessRegistry,
      ) => new SkillsService(harvest, adapters, processes),
      inject: [SkillHarvestStore, AgentAdapterRegistry, ProcessRegistry],
    },
    {
      // Factory because the trailing options bag is a test seam, not a DI token.
      provide: ModelsService,
      useFactory: (
        adapters: AgentAdapterRegistry,
        processes: ProcessRegistry,
      ) => new ModelsService(adapters, processes),
      inject: [AgentAdapterRegistry, ProcessRegistry],
    },
    // Plain provider, unlike its siblings above: it has no options bag to seed,
    // because an adapter answers from a documented constant (no spawn, no TTL).
    EffortsService,
    AgentEventBus,
    ApprovalRegistry,
    PartialStreamService,
    ProcessRegistry,
    RunTeardownService,
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
          // The command-catalog probe's throwaway workspace — daemon-owned,
          // never a user folder.
          probeRootDir: join(environment.userDataDir, 'claude-probe'),
          // Without a real sink the base class's diagnostics (skipped
          // unparseable lines, unmodelled control subtypes, a failed turn
          // resource disposer) are `?.warn` on undefined — silently discarded
          // in the one build that matters.
          logger: new Logger(ClaudeAdapter.name),
        }),
    },
    {
      provide: CursorAcpAdapter,
      useFactory: () =>
        new CursorAcpAdapter({ logger: new Logger(CursorAcpAdapter.name) }),
    },
    {
      // Factory because the trailing options bag is a test seam, not a DI token.
      provide: ClaudeProbeService,
      useFactory: (adapter: ClaudeAdapter, processes: ProcessRegistry) =>
        new ClaudeProbeService(adapter, processes),
      inject: [ClaudeAdapter, ProcessRegistry],
    },
  ],
  exports: [
    AgentEventBus,
    ApprovalRegistry,
    PartialStreamService,
    ClaudeProbeService,
    ProcessRegistry,
    // Exported for the graph executor's own run delete: one teardown serves
    // both run kinds, so neither can drift out of clearing a store.
    RunTeardownService,
    SkillHarvestStore,
    CursorMcpCleanupService,
    ItemDao,
    NodeStateDao,
    RunDao,
    ClaudeAdapter,
    CursorAcpAdapter,
    AgentAdapterRegistry,
  ],
})
export class AgentsModule {}

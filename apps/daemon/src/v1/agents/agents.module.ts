import { join } from 'node:path';

import { Logger, Module } from '@nestjs/common';

import { environment } from '../../environments';
import { createTeeingSpawn } from '../diagnostics/utils/teeing-spawn';
import { ClaudeAdapter } from './adapters/claude/claude.adapter';
import { ClaudeProbeService } from './adapters/claude/claude-probe.service';
import { CursorAcpAdapter } from './adapters/cursor-acp/cursor-acp.adapter';
import {
  CURSOR_PROFILE_DIR_NAME,
  CURSOR_SESSION_STORE_DIR_NAME,
} from './adapters/cursor-acp/cursor-acp.const';
import { ChatController } from './controllers/chat.controller';
import { McpController } from './controllers/mcp.controller';
import { SkillsController } from './controllers/skills.controller';
import { ItemDao } from './dao/item.dao';
import { NodeStateDao } from './dao/node-state.dao';
import { RunDao } from './dao/run.dao';
import { AgentAdapterRegistry } from './services/agent-adapter.registry';
import { AgentEventBus } from './services/agent-events.bus';
import { AgentMcpService } from './services/agent-mcp.service';
import { AgentSessionRegistry } from './services/agent-session.registry';
import { AgentVersionService } from './services/agent-version.service';
import { ApprovalRegistry } from './services/approval-registry';
import { AttachmentStoreService } from './services/attachment-store.service';
import { ChatService } from './services/chat.service';
import { ContextWindowStore } from './services/context-window.store';
import { EffortsService } from './services/efforts.service';
import { ItemSeqAllocator } from './services/item-seq.allocator';
import { McpHarvestStore } from './services/mcp-harvest.store';
import { ModelsService } from './services/models.service';
import { PartialStreamService } from './services/partial-stream.service';
import { ProcessRegistry } from './services/process-registry';
import { RunTeardownService } from './services/run-teardown.service';
import { SkillHarvestStore } from './services/skill-harvest.store';
import { SkillsService } from './services/skills.service';
import { StrandedChildReaper } from './services/stranded-child-reaper.service';
import { CHILD_JOURNAL_FILE_NAME } from './utils/child-journal';
import { defaultSpawn } from './utils/spawn-cli';

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
  controllers: [ChatController, McpController, SkillsController],
  providers: [
    ChatService,
    AgentAdapterRegistry,
    AgentVersionService,
    // Factories because the trailing options bags are test seams, not DI tokens.
    { provide: SkillHarvestStore, useFactory: () => new SkillHarvestStore() },
    { provide: McpHarvestStore, useFactory: () => new McpHarvestStore() },
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
        versions: AgentVersionService,
      ) => new SkillsService(harvest, adapters, processes, versions),
      inject: [
        SkillHarvestStore,
        AgentAdapterRegistry,
        ProcessRegistry,
        AgentVersionService,
      ],
    },
    {
      // Factory because the trailing options bag is a test seam, not a DI token.
      provide: AgentMcpService,
      useFactory: (
        adapters: AgentAdapterRegistry,
        processes: ProcessRegistry,
        versions: AgentVersionService,
        harvest: McpHarvestStore,
      ) => new AgentMcpService(adapters, processes, versions, harvest),
      inject: [
        AgentAdapterRegistry,
        ProcessRegistry,
        AgentVersionService,
        McpHarvestStore,
      ],
    },
    {
      // Factory because the trailing options bag is a test seam, not a DI token.
      provide: ModelsService,
      useFactory: (
        adapters: AgentAdapterRegistry,
        processes: ProcessRegistry,
        versions: AgentVersionService,
      ) => new ModelsService(adapters, processes, versions),
      inject: [AgentAdapterRegistry, ProcessRegistry, AgentVersionService],
    },
    // Plain provider, unlike its siblings above: it has no options bag to seed,
    // because an adapter answers from a documented constant (no spawn, no TTL).
    EffortsService,
    AgentEventBus,
    ApprovalRegistry,
    {
      provide: ContextWindowStore,
      useFactory: () => new ContextWindowStore(),
    },
    PartialStreamService,
    ProcessRegistry,
    AgentSessionRegistry,
    {
      // Factory because the trailing options bag is a test seam, not a DI
      // token — and because the journal path is config, not a dependency.
      provide: StrandedChildReaper,
      useFactory: () =>
        new StrandedChildReaper(
          join(environment.userDataDir, CHILD_JOURNAL_FILE_NAME),
        ),
    },
    RunTeardownService,
    ItemSeqAllocator,
    ItemDao,
    NodeStateDao,
    RunDao,
    {
      provide: ClaudeAdapter,
      // Per-turn --mcp-config files live under the daemon's own userData tmp
      // (never the OS-shared tmpdir) — they carry the per-run call token.
      useFactory: () =>
        new ClaudeAdapter({
          // The `agent-stdio` debug channel, wired at the ONE seam every
          // adapter already shares. Inert unless that channel is switched on,
          // and it knows nothing about which CLI it is wrapping — see
          // `createTeeingSpawn` for why the spawn is the right seam.
          spawn: createTeeingSpawn(defaultSpawn),
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
        new CursorAcpAdapter({
          spawn: createTeeingSpawn(defaultSpawn),
          logger: new Logger(CursorAcpAdapter.name),
          // Per-turn config directories, so applying a model or an effort over
          // ACP cannot reach the user's own `~/.cursor/cli-config.json` — that
          // write is real and measured; see `utils/cursor-profile.utils.ts`.
          profileDir: join(environment.userDataDir, CURSOR_PROFILE_DIR_NAME),
          // The conversations, which must OUTLIVE the turn profile that opens
          // them: the CLI keeps each thread inside its config directory, so a
          // store nested in the profile is deleted with it and the chat's next
          // message dies at `session/load`. Its own directory, because the
          // profile base is swept wholesale at boot.
          sessionStoreDir: join(
            environment.userDataDir,
            CURSOR_SESSION_STORE_DIR_NAME,
          ),
        }),
    },
    {
      // Factory because the trailing options bag is a test seam, not a DI token.
      provide: ClaudeProbeService,
      useFactory: (
        adapter: ClaudeAdapter,
        processes: ProcessRegistry,
        versions: AgentVersionService,
      ) => new ClaudeProbeService(adapter, processes, versions),
      inject: [ClaudeAdapter, ProcessRegistry, AgentVersionService],
    },
  ],
  exports: [
    AgentEventBus,
    ApprovalRegistry,
    PartialStreamService,
    // Exported for the graphs module: the executor reads this CLI's probed
    // permission modes when it builds a node's turn, and `/v1/capabilities`
    // publishes the same verdict to the builder.
    ClaudeProbeService,
    ProcessRegistry,
    // Exported so the graph executor's own run delete reaches the same
    // teardown obligation a chat delete does — a run-scoped CLI process is
    // reaped by nothing else.
    AgentSessionRegistry,
    // Exported for main.ts's boot sweep — it runs before the server listens,
    // beside the other reconciles a crashed launch leaves behind.
    StrandedChildReaper,
    // Exported for the graph executor's own run delete: one teardown serves
    // both run kinds, so neither can drift out of clearing a store.
    RunTeardownService,
    SkillHarvestStore,
    // Exported for the graph executor's own turn seam: a node's turn reports
    // what it loaded, and that report is what keeps the MCP panel off a cold
    // re-dial.
    McpHarvestStore,
    ItemDao,
    NodeStateDao,
    RunDao,
    ClaudeAdapter,
    CursorAcpAdapter,
    AgentAdapterRegistry,
    // Exported for the diagnostics report, which names each CLI and the
    // version that binary answers with. Through this ONE service so the
    // report costs no new spawn: it serves the same per-binary memo the rest
    // of the daemon reads.
    AgentVersionService,
  ],
})
export class AgentsModule {}

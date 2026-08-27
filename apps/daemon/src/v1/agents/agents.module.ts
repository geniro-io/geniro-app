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
import { RunGroupsController } from './controllers/run-groups.controller';
import { SkillsController } from './controllers/skills.controller';
import { ItemDao } from './dao/item.dao';
import { NodeStateDao } from './dao/node-state.dao';
import { RunDao } from './dao/run.dao';
import { RunGroupDao } from './dao/run-group.dao';
import { AgentAdapterRegistry } from './services/agent-adapter.registry';
import { AgentEventBus } from './services/agent-events.bus';
import { AgentMcpService } from './services/agent-mcp.service';
import { AgentSessionRegistry } from './services/agent-session.registry';
import { AgentVersionService } from './services/agent-version.service';
import { ApprovalRegistry } from './services/approval-registry';
import { AttachmentStoreService } from './services/attachment-store.service';
import { CacheResetService } from './services/cache-reset.service';
import { ChatService } from './services/chat.service';
import { ChatMetricsService } from './services/chat-metrics.service';
import { ChatTitleService } from './services/chat-title.service';
import { CliSessionsService } from './services/cli-sessions.service';
import { ConfigDirPinService } from './services/config-dir-pin.service';
import { ContextWindowStore } from './services/context-window.store';
import { ContextWindowsService } from './services/context-windows.service';
import { EffortsService } from './services/efforts.service';
import { ItemSeqAllocator } from './services/item-seq.allocator';
import { LocalImageService } from './services/local-image.service';
import { McpHarvestStore } from './services/mcp-harvest.store';
import { ModelParametersService } from './services/model-parameters.service';
import { ModelVocabularyStore } from './services/model-vocabulary.store';
import { ModelsService } from './services/models.service';
import { PartialStreamService } from './services/partial-stream.service';
import { ProcessRegistry } from './services/process-registry';
import { RunGroupsService } from './services/run-groups.service';
import { RunTeardownService } from './services/run-teardown.service';
import { ShellOutputService } from './services/shell-output.service';
import { SkillHarvestStore } from './services/skill-harvest.store';
import { SkillsService } from './services/skills.service';
import { StrandedChildReaper } from './services/stranded-child-reaper.service';
import { UserQuestionBroker } from './services/user-question.broker';
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
  controllers: [
    ChatController,
    McpController,
    RunGroupsController,
    SkillsController,
  ],
  providers: [
    ChatService,
    UserQuestionBroker,
    CacheResetService,
    AgentAdapterRegistry,
    AgentVersionService,
    ChatMetricsService,
    ChatTitleService,
    LocalImageService,
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
        sessions: AgentSessionRegistry,
      ) =>
        new AgentMcpService(adapters, processes, versions, harvest, sessions),
      inject: [
        AgentAdapterRegistry,
        ProcessRegistry,
        AgentVersionService,
        McpHarvestStore,
        AgentSessionRegistry,
      ],
    },
    {
      // Factory because the trailing options bag is a test seam, not a DI token.
      provide: ModelsService,
      useFactory: (
        adapters: AgentAdapterRegistry,
        processes: ProcessRegistry,
        versions: AgentVersionService,
        store: ModelVocabularyStore,
      ) => new ModelsService(adapters, processes, versions, store),
      inject: [
        AgentAdapterRegistry,
        ProcessRegistry,
        AgentVersionService,
        ModelVocabularyStore,
      ],
    },
    // Plain provider, unlike its siblings above: it has no options bag to seed,
    // because an adapter answers from a documented constant (no spawn, no TTL).
    CliSessionsService,
    ConfigDirPinService,
    {
      // A factory now, and for the same reason `ModelsService` is one: asking a
      // model's effort axis SPAWNS a CLI handshake, so this gained a version
      // key, a TTL and a single-flight — and the options bag behind them is a
      // test seam, not a DI token.
      provide: EffortsService,
      useFactory: (
        adapters: AgentAdapterRegistry,
        processes: ProcessRegistry,
        versions: AgentVersionService,
      ) => new EffortsService(adapters, processes, versions),
      inject: [AgentAdapterRegistry, ProcessRegistry, AgentVersionService],
    },
    {
      // Its twin, and a factory for the identical reason: asking a model's
      // window sizes spawns the same handshake, so it carries the same version
      // key, TTL and single-flight (`ModelVocabularyCache`, shared with it).
      provide: ContextWindowsService,
      useFactory: (
        adapters: AgentAdapterRegistry,
        processes: ProcessRegistry,
        versions: AgentVersionService,
      ) => new ContextWindowsService(adapters, processes, versions),
      inject: [AgentAdapterRegistry, ProcessRegistry, AgentVersionService],
    },
    {
      // The THIRD reader of that one handshake, and a factory for the same
      // reason again. It differs from its two siblings only in what it takes
      // out of the reply: everything they did not.
      provide: ModelParametersService,
      useFactory: (
        adapters: AgentAdapterRegistry,
        processes: ProcessRegistry,
        versions: AgentVersionService,
      ) => new ModelParametersService(adapters, processes, versions),
      inject: [AgentAdapterRegistry, ProcessRegistry, AgentVersionService],
    },
    AgentEventBus,
    ApprovalRegistry,
    {
      provide: ContextWindowStore,
      useFactory: () => new ContextWindowStore(),
    },
    {
      // Factory for the same reason its neighbour is one: the options bag is a
      // test seam, not a DI token.
      provide: ModelVocabularyStore,
      useFactory: () => new ModelVocabularyStore(),
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
    RunGroupsService,
    ShellOutputService,
    ItemSeqAllocator,
    ItemDao,
    NodeStateDao,
    RunDao,
    RunGroupDao,
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
      inject: [ModelVocabularyStore, AgentVersionService],
      useFactory: (
        vocabularyStore: ModelVocabularyStore,
        versions: AgentVersionService,
      ) =>
        new CursorAcpAdapter({
          // The `--version` this CLI's every cache is keyed by, read through
          // the daemon's 60s memo — without it a cache HIT still forked, and
          // the settings panel asks for three listings.
          versions,
          // The handshake replies that survive a restart — the difference
          // between a model's settings appearing in 6s and in the frame the
          // panel opens.
          vocabularyStore,
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
    // Exported for the graphs module: its MCP host serves the
    // `ask_user_question` tool through this broker, and the turn that can
    // actually put the card on screen registers here.
    UserQuestionBroker,
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
    // Exported so `CliAuthService` can drop an agent's cached vocabularies the
    // moment it signs that agent in or out: a different account is a different
    // set of models, and nothing about that moves the CLI's `--version`.
    ModelVocabularyStore,
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

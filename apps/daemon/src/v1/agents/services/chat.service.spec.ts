import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { CallTokenRegistry } from '../../../auth/call-token.registry';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import { freshVocabularyStore } from '../adapters/__tests__/fresh-vocabulary-store';
import type {
  AgentApprovalMode,
  AgentEvent,
  AgentTurnInput,
  CarrySessionInput,
  InstalledApprovalSupport,
  InstalledCapabilities,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import type { ClaudeProbeService } from '../adapters/claude/claude-probe.service';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';
import type {
  ClaudeModesCapability,
  RunDeltaEvent,
  RunItemEvent,
  RunStatusEvent,
} from '../chat.types';
import { HOST_QUESTION_TOOL, SINGLE_AGENT_NODE } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { hostMcpServerName } from '../utils/host-question';
import { FakeContextWindowStore } from './__tests__/fake-context-window-store';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentEventBus } from './agent-events.bus';
import { AgentSessionRegistry } from './agent-session.registry';
import { AgentVersionService } from './agent-version.service';
import { ApprovalRegistry } from './approval-registry';
import type { AttachmentStoreService } from './attachment-store.service';
import { ChatService } from './chat.service';
import type { CliSessionsService } from './cli-sessions.service';
import { ConfigDirPinService } from './config-dir-pin.service';
import { EffortsService } from './efforts.service';
import { FindingsReportBroker } from './findings-report.broker';
import { ItemSeqAllocator } from './item-seq.allocator';
import type { McpHarvestStore } from './mcp-harvest.store';
import { PartialStreamService } from './partial-stream.service';
import { ProcessRegistry } from './process-registry';
import { RunContextRegistry } from './run-context.registry';
import { RunGroupsService } from './run-groups.service';
import { RunTeardownService } from './run-teardown.service';
import type { SkillHarvestStore } from './skill-harvest.store';
import { UserQuestionBroker } from './user-question.broker';

// ── In-memory fakes (the DAOs ignore the passed EntityManager) ───────────────
class FakeRunDao {
  readonly runs = new Map<string, Run>();
  /** Every `hardDeleteIncludingSoftDeleted` call, so the spec can spy it. */
  readonly hardDeleted: unknown[] = [];
  /**
   * When set, the run-row purge blocks on it — a test seam for the window in
   * which a delete is IN FLIGHT: cancelled and past its own guards, but with
   * the rows still present, which is precisely the state `getById` cannot
   * detect and only the `deleting` Set covers.
   */
  purgeGate: Promise<void> | null = null;
  private n = 0;
  async getById(id: string): Promise<Run | null> {
    return this.runs.get(id) ?? null;
  }
  async hardDeleteIncludingSoftDeleted(where: { id: string }): Promise<number> {
    this.hardDeleted.push(where);
    if (this.purgeGate) {
      await this.purgeGate;
    }
    return this.runs.delete(where.id) ? 1 : 0;
  }
  async create(data: Partial<Run>): Promise<Run> {
    const run = {
      id: `run-${this.n++}`,
      title: null,
      status: 'pending',
      workflowId: null,
      cwd: null,
      agentKind: null,
      model: null,
      // The column's own default, spelled out: a fixture that omits it hands
      // `runToWire` an `undefined` the real entity can never produce.
      modelParameters: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...data,
    } as unknown as Run;
    this.runs.set(run.id, run);
    return run;
  }
  async updateById(id: string, data: Partial<Run>): Promise<number> {
    const run = this.runs.get(id);
    if (!run) {
      return 0;
    }
    Object.assign(run, data);
    return 1;
  }
  /** The real one writes the column explicitly; so does this. */
  async touch(id: string, at: Date = new Date()): Promise<void> {
    const run = this.runs.get(id);
    if (run) {
      run.updatedAt = at;
    }
  }
  async listChats(): Promise<Run[]> {
    return [...this.runs.values()];
  }
  async setPendingContext(id: string, context: string | null): Promise<void> {
    const run = this.runs.get(id);
    if (run) {
      run.pendingContext = context;
    }
  }
  /** Mirrors the real read-and-clear: the column is consumed exactly once. */
  async takePendingContext(id: string): Promise<string | null> {
    const run = this.runs.get(id);
    const pending = run?.pendingContext ?? null;
    if (run) {
      run.pendingContext = null;
    }
    return pending;
  }
  async listRunningChats(): Promise<Run[]> {
    // Mirrors the real query's chat-only scoping (workflowId null).
    return [...this.runs.values()].filter(
      (run) => run.status === 'running' && run.workflowId === null,
    );
  }
  /** The one write that DOES clear — see `RunDao.forgetContext`. */
  async forgetContext(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (run) {
      run.contextTokens = null;
    }
  }
  /** The reading kept from a closed session — see `Run.lastMetricsReading`. */
  async rememberMetricsReading(
    id: string,
    reading: string | null,
  ): Promise<void> {
    const run = this.runs.get(id);
    if (run) {
      run.lastMetricsReading = reading;
    }
  }
  /** Mirrors the real write: the window is only ever set, never cleared. */
  async rememberContext(
    id: string,
    reading: {
      contextTokens?: number | null;
      contextWindowTokens?: number | null;
    },
  ): Promise<void> {
    const run = this.runs.get(id);
    if (!run) {
      return;
    }
    if (
      typeof reading.contextTokens === 'number' &&
      reading.contextTokens > 0
    ) {
      run.contextTokens = reading.contextTokens;
    }
    if (
      typeof reading.contextWindowTokens === 'number' &&
      reading.contextWindowTokens > 0
    ) {
      run.contextWindowTokens = reading.contextWindowTokens;
    }
  }
  /** Mirrors the real `nativeUpdate` — every run holding a value, count back. */
  async forgetCustomInstructions(): Promise<number> {
    let cleared = 0;
    for (const run of this.runs.values()) {
      if (run.customInstructions !== null) {
        run.customInstructions = null;
        cleared += 1;
      }
    }
    return cleared;
  }
}

class FakeItemDao {
  readonly items: Item[] = [];
  readonly hardDeleted: unknown[] = [];
  failNextKind: string | null = null;
  async hardDeleteIncludingSoftDeleted(where: {
    runId: string;
  }): Promise<number> {
    this.hardDeleted.push(where);
    const before = this.items.length;
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i]!.runId === where.runId) {
        this.items.splice(i, 1);
      }
    }
    return before - this.items.length;
  }
  async create(data: Partial<Item>): Promise<Item> {
    if (data.kind === this.failNextKind) {
      this.failNextKind = null;
      throw new Error('SQLITE_FULL');
    }
    const item = {
      id: `item-${this.items.length}`,
      nodeId: null,
      role: null,
      createdAt: new Date(0),
      ...data,
    } as unknown as Item;
    this.items.push(item);
    return item;
  }
  async getByRun(runId: string, afterSeq = -1): Promise<Item[]> {
    return this.items
      .filter((i) => i.runId === runId && i.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq);
  }
  async maxSeq(runId: string): Promise<number> {
    const seqs = this.items.filter((i) => i.runId === runId).map((i) => i.seq);
    return seqs.length ? Math.max(...seqs) : -1;
  }
  // Mirrors the real DAO (pinned by item.dao.spec.ts): per run, ONLY the
  // highest-seq `message` item is consulted — a text-less or malformed head
  // yields no preview (no fallback to earlier messages, no throw).
  async latestMessageTextPerRun(
    runIds: string[],
  ): Promise<Map<string, string>> {
    const previews = new Map<string, string>();
    for (const runId of runIds) {
      const head = this.items
        .filter((i) => i.runId === runId && i.kind === 'message')
        .sort((a, b) => b.seq - a.seq)[0];
      if (!head) {
        continue;
      }
      try {
        const text = (JSON.parse(head.payload) as { text?: string }).text;
        if (typeof text === 'string') {
          previews.set(runId, text);
        }
      } catch {
        // Malformed head payload — run stays absent, like the real query.
      }
    }
    return previews;
  }
}

class FakeNodeStateDao {
  readonly saved: string[] = [];
  readonly hardDeleted: unknown[] = [];
  async hardDeleteIncludingSoftDeleted(where: {
    runId: string;
  }): Promise<number> {
    this.hardDeleted.push(where);
    return 0;
  }
  private state: NodeState | null = null;
  preset(sessionId: string | null): void {
    this.state = sessionId
      ? ({ agentSessionId: sessionId } as unknown as NodeState)
      : null;
  }
  async getByRunNode(): Promise<NodeState | null> {
    return this.state;
  }
  /**
   * The full call, for the assertions that care WHERE the id landed rather
   * than only that one did — `saved` above keeps its bare-id shape so the
   * turn-lifecycle tests read as they did.
   */
  readonly savedFor: { runId: string; nodeId: string; sessionId: string }[] =
    [];
  async saveSessionId(
    runId: string,
    nodeId: string,
    sessionId: string,
  ): Promise<void> {
    this.savedFor.push({ runId, nodeId, sessionId });
    this.saved.push(sessionId);
    this.state = { agentSessionId: sessionId } as unknown as NodeState;
  }
  readonly cleared: { runId: string; nodeId: string }[] = [];
  async clearSessionId(runId: string, nodeId: string): Promise<void> {
    this.cleared.push({ runId, nodeId });
    this.state = null;
  }
}

function fakeAdapter(kind: AgentKind): {
  adapter: ClaudeAdapter;
  start: ReturnType<typeof vi.fn>;
  emit: (event: AgentEvent) => void;
  finish: () => void;
  /** Hold the next turn inside its pre-spawn probe until the returned fn runs. */
  stallBeforeSpawn: () => () => void;
  handles: {
    respondApproval: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    sendUserMessage: ReturnType<typeof vi.fn>;
    setApprovalMode: ReturnType<typeof vi.fn>;
  }[];
  /** Every session the service opened, and whether each was closed. */
  sessions: {
    closed: boolean;
    /**
     * The between-turn approval policy the session was opened WITH — the one
     * the live process actually calls for a request that arrives with no turn
     * in flight. Recorded rather than reconstructed: the registry wraps the
     * caller's closure in its own holder indirection, and only the wrapper is
     * what the CLI reaches.
     */
    betweenTurnApproval?: (request: {
      toolName: string;
      requiresUserInteraction?: boolean;
    }) => boolean | null;
    /**
     * Where the session sends an event it produced with no turn in flight —
     * the only path a spec can drive to play a run-scoped CLI still finishing
     * a turn that has already settled.
     */
    onBetweenTurnEvent?: (event: AgentEvent) => void;
    /**
     * Where the session offers a request the posture will not decide — the only
     * path a spec can drive to play a question arriving with no turn to raise a
     * card through, which is the incident this seam exists for.
     */
    onHeldApproval?: (
      event: Extract<AgentEvent, { type: 'approval_request' }>,
      respond: (allow: boolean, input?: unknown) => boolean,
    ) => boolean;
  }[];
} {
  let onEvent: ((event: AgentEvent) => void) | null = null;
  /** When set, the pre-spawn probe blocks on it — see supportsLiveStream. */
  let streamGate: Promise<void> | null = null;
  let resolveDone: (() => void) | null = null;
  const handles: {
    respondApproval: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    sendUserMessage: ReturnType<typeof vi.fn>;
    setApprovalMode: ReturnType<typeof vi.fn>;
  }[] = [];
  const start = vi.fn(
    (input: AgentTurnInput, cb: (event: AgentEvent) => void) => {
      void input;
      onEvent = cb;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const handle = {
        done,
        // Cancelling a REAL handle kills the child, so `done` settles a moment
        // later — the fake settles it too. A cancel that left `done` pending
        // forever would model a wedged child as the normal case, and any code
        // that waits for a cancelled turn to finish would look like a hang.
        cancel: vi.fn(() => resolveDone?.()),
        // A live turn delivers verdicts — true is the realistic default.
        respondApproval: vi.fn(() => true),
        // Same for a follow-up: a running claude turn takes one on its still-open
        // stream-json stdin (probe-verified). A spec about the CLI that cannot
        // overrides it to false.
        sendUserMessage: vi.fn(() => true),
        // A chat turn always spawns question-capable, so it always holds the
        // permission dialogue and can always be re-moded — true is the
        // realistic default. A spec about a turn that CANNOT overrides it.
        setApprovalMode: vi.fn(() => true),
      };
      handles.push(handle);
      return handle;
    },
  );
  // The double fakes the SPAWN, and a session is a spawned PROCESS — so it is
  // faked here too, at the same seam. Each turn still goes through `start`, so
  // every assertion counting spawns keeps counting turns; what the session adds
  // is the lifetime around them, which is the thing a delete has to end.
  const sessions: {
    closed: boolean;
    betweenTurnApproval?: (request: {
      toolName: string;
      requiresUserInteraction?: boolean;
    }) => boolean | null;
    /**
     * Captured so a spec can play the one thing only a run-scoped process can
     * do: emit AFTER its turn settled. Nothing else can reach that path.
     */
    onBetweenTurnEvent?: (event: AgentEvent) => void;
    /**
     * Captured for the same reason: a request the posture will not decide is
     * offered to the OWNER here, and this is the only way a spec can play one
     * arriving with no turn to raise it.
     */
    onHeldApproval?: (
      event: Extract<AgentEvent, { type: 'approval_request' }>,
      respond: (allow: boolean, input?: unknown) => boolean,
    ) => boolean;
  }[] = [];
  const startSession = vi.fn(
    (
      _input: AgentTurnInput,
      opts: {
        betweenTurnApproval?: (request: {
          toolName: string;
          requiresUserInteraction?: boolean;
        }) => boolean | null;
        onBetweenTurnEvent?: (event: AgentEvent) => void;
        onHeldApproval?: (
          event: Extract<AgentEvent, { type: 'approval_request' }>,
          respond: (allow: boolean, input?: unknown) => boolean,
        ) => boolean;
      } = {},
    ) => {
      const record = {
        closed: false,
        betweenTurnApproval: opts.betweenTurnApproval,
        onBetweenTurnEvent: opts.onBetweenTurnEvent,
        onHeldApproval: opts.onHeldApproval,
      };
      sessions.push(record);
      let inFlight = 0;
      return {
        startTurn: (input: AgentTurnInput, cb: (event: AgentEvent) => void) => {
          const handle = start(input, cb);
          inFlight += 1;
          void handle.done.then(() => {
            inFlight -= 1;
          });
          return handle;
        },
        get idle() {
          return inFlight === 0;
        },
        get alive() {
          return !record.closed;
        },
        close: () => {
          record.closed = true;
        },
        // Never resolves: nothing in the daemon awaits a session's death, and a
        // promise that resolved on its own would model a process that reaps
        // itself — which is exactly what a run-scoped one does not do.
        closed: new Promise<void>(() => {}),
      };
    },
  );

  // Every CLI-fact declaration comes from the REAL adapter: the double fakes
  // the SPAWN, never the contract, so a policy this service leans on cannot
  // pass here while being absent from the adapter that ships. The whole
  // `config` object is carried through by REFERENCE rather than field by
  // field — a hand-mirrored copy is exactly how a config change keeps passing
  // the tests it should have broken.
  const real: AgentAdapter =
    kind === 'claude'
      ? new ClaudeAdapter()
      : new CursorAcpAdapter({
          vocabularyStore: freshVocabularyStore(),
        });
  return {
    adapter: {
      getConfig: () => real.getConfig(),
      start,
      startSession,
      resolveApprovalMode: (
        requested: AgentApprovalMode,
        installed: InstalledApprovalSupport,
      ) => real.resolveApprovalMode(requested, installed),
      approvalSupportFrom: (capabilities: InstalledCapabilities) =>
        real.approvalSupportFrom(capabilities),
      // The answer fold is the adapter's too: the double must not decide
      // where a verdict's free text lands inside a CLI's tool input.
      withAnswer: (input: unknown, answer: string) =>
        real.withAnswer(input, answer),
      // Mirrors the real adapters: only claude can stream partial text.
      // A test seam for the claim→register window: the real adapter probes the
      // installed CLI here, so this is where a concurrent delete lands.
      supportsLiveStream: () =>
        streamGate === null
          ? Promise.resolve(kind === 'claude')
          : streamGate.then(() => kind === 'claude'),
      listEfforts: () => real.listEfforts(),
      // The REAL lookup over the REAL adapter's own command list: what
      // `/compact` does — and whether the CLI has it at all — is the fact
      // under test wherever this double is asked, and a stub answering null
      // would let the dispatch rot while every spec stayed green.
      listGeniroCommands: () => real.listGeniroCommands(),
      geniroCommandFor: (text: string) => real.geniroCommandFor(text),
      // The REAL copy, into the REAL directories the spec hands it. This one
      // touches no process at all — it is a file move inside the CLI's own
      // store — so stubbing it would replace the whole mechanism under test
      // with a promise that it was called.
      carrySessionToConfigDir: (input: CarrySessionInput) =>
        real.carrySessionToConfigDir(input),
      // Real for the same reason: it is a settings-file read against the cwd
      // the spec supplies, with no process anywhere in it, so a stub would
      // replace the mechanism with an assertion that it was called.
      readConfigDirPin: (cwd: string) => real.readConfigDirPin(cwd),
      // The real one opens a handshake, which is the spawn this double exists
      // to avoid — so it answers as the base does when it cannot ask: the
      // CLI-wide union, marked INEXACT so it can never ground a refusal. A test
      // that needs one model's own list stubs this.
      listModelEfforts: async () => ({
        efforts: [...real.getConfig().efforts],
        unavailableReason: real.getConfig().effortsUnavailableReason,
        exact: false,
      }),
      // Real, and it has to be: it answers "is this CLI's account a directory"
      // off that CLI's own config, which is what every vocabulary cache keys
      // by. Stubbing it would key both doubles the same way and hide exactly
      // the confusion the key exists to prevent.
      vocabularyProfile: (configDir: string | null) =>
        real.vocabularyProfile(configDir),
    } as unknown as ClaudeAdapter,
    start,
    emit: (event) => onEvent?.(event),
    finish: () => resolveDone?.(),
    /** Hold the next turn inside its pre-spawn probe until the returned fn runs. */
    stallBeforeSpawn: (): (() => void) => {
      let release = (): void => {};
      streamGate = new Promise<void>((resolve) => {
        release = () => {
          streamGate = null;
          resolve();
        };
      });
      return release;
    },
    handles,
    sessions,
  };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await tick();
  }
}

function setup(
  opts: {
    claudeModes?: ClaudeModesCapability;
    mcpSettingsFile?: string;
    /**
     * The daemon's bound port, or null for a launch that has none. Null is the
     * case the endpoint guard exists for: with no port there is no URL to
     * publish, so no token is minted either.
     */
    port?: number | null;
    /** What the sidebar's auto-filing rule answers for a new chat's cwd. */
    autoGroupId?: string | null;
    /**
     * Overrides for the CLI-sessions double, for the tests that DO create a
     * chat from a conversation the CLI already holds.
     */
    cliSessions?: Partial<
      Pick<CliSessionsService, 'prepare' | 'importHistory'>
    >;
  } = {},
) {
  const runDao = new FakeRunDao();
  const itemDao = new FakeItemDao();
  const nodeDao = new FakeNodeStateDao();
  const published: RunItemEvent[] = [];
  const deltas: RunDeltaEvent[] = [];
  const deletedRuns: string[] = [];
  const statuses: RunStatusEvent[] = [];
  const bus = {
    publish: (event: RunItemEvent) => published.push(event),
    publishDelta: (event: RunDeltaEvent) => deltas.push(event),
    publishRunStatus: (event: RunStatusEvent) => statuses.push(event),
    publishRunDeleted: (runId: string) => deletedRuns.push(runId),
  } as unknown as AgentEventBus;
  const registry = new ProcessRegistry();
  // A REAL one: it is the thing every status broadcast is stamped from, so a
  // double would make the spec's own statuses disagree with the daemon's.
  const contexts = new RunContextRegistry();
  const approvals = new ApprovalRegistry();
  const claude = fakeAdapter('claude');
  const cursor = fakeAdapter('cursor-agent');
  const em = {
    fork: () => ({ clear: () => undefined }),
  } as unknown as EntityManager;
  const skillHarvest = {
    record: vi.fn(),
    get: () => null,
  } as unknown as SkillHarvestStore;
  const mcpHarvest = {
    record: vi.fn(),
    get: () => null,
  } as unknown as McpHarvestStore;
  const claudeModes: ClaudeModesCapability = opts.claudeModes ?? {
    acceptEdits: 'pass',
    plan: 'pass',
    version: 'claude-test',
    probedAt: 0,
    reason: null,
  };
  const removedAttachmentRuns: string[] = [];
  const attachments = {
    save: () => ({ id: 'att-0', mediaType: 'image/png' }),
    pathOf: (runId: string, id: string) => `/tmp/${runId}/${id}`,
    removeRun: (runId: string) => removedAttachmentRuns.push(runId),
  } as unknown as AttachmentStoreService;
  const partials = new PartialStreamService(
    bus,
    new FakeContextWindowStore().asStore(),
  );
  const callTokens = new CallTokenRegistry();
  const userQuestions = new UserQuestionBroker();
  const findingsReports = new FindingsReportBroker();
  const claudeProbe = {
    capability: () => claudeModes,
    ensureVerdict: vi.fn(async () => claudeModes),
    wireCapability: () => claudeModes,
  } as unknown as ClaudeProbeService;
  // The REAL service over the fake adapters: what it refuses is exactly what
  // they decline to list, which is the behaviour the effort tests below pin.
  // One registry over the fake adapters, exactly as the module wires it: the
  // services under test resolve a kind through it rather than holding two
  // adapters each.
  const adapters = new AgentAdapterRegistry(
    claude.adapter,
    cursor.adapter as unknown as CursorAcpAdapter,
  );
  const efforts = new EffortsService(
    adapters,
    new ProcessRegistry(),
    new AgentVersionService(),
  );
  // The REAL teardown over the same fakes: `delete` is a thin caller of it, so
  // a mock here would leave every assertion below pinning the mock.
  // A real one: it holds nothing but in-memory buffers, so a double would
  // only hide whether the turn is actually tee'd into it.
  // Real, like its neighbours: it holds an in-memory map of CLI processes, and
  // a double would hide whether a delete actually closes the run's own.
  const sessions = new AgentSessionRegistry();
  // The REAL allocator over the fake DAO, like its neighbours: it IS the thing
  // that keeps a turn's writes and a mid-turn follow-up from sharing a seq, so
  // a double here would leave the duplicate-seq tests pinning the double.
  const seqs = new ItemSeqAllocator(em, itemDao as unknown as ItemDao);
  const teardown = new RunTeardownService(
    itemDao as unknown as ItemDao,
    nodeDao as unknown as NodeStateDao,
    runDao as unknown as RunDao,
    bus,
    registry,
    sessions,
    callTokens,
    partials,
    attachments,
    seqs,
  );
  // A double rather than the real service: what THIS spec pins is that the
  // group the rule names lands on the created run, not how the rule reads a
  // directory tree — `run-groups.service.spec.ts` owns that, over its own rows.
  const assertedGroups: string[] = [];
  const groups = {
    resolveAutoGroupId: async () => opts.autoGroupId ?? null,
    assertExists: async (groupId: string) => {
      assertedGroups.push(groupId);
    },
  } as unknown as RunGroupsService;
  const service = new ChatService(
    em,
    runDao as unknown as RunDao,
    itemDao as unknown as ItemDao,
    nodeDao as unknown as NodeStateDao,
    bus,
    contexts,
    registry,
    sessions,
    approvals,
    adapters,
    claudeProbe,
    skillHarvest,
    mcpHarvest,
    attachments,
    partials,
    teardown,
    efforts,
    seqs,
    groups,
    // A double, because the real service would reach the adapters — but a
    // CONFIGURABLE one: what the adapters answer belongs to
    // `cli-sessions.service.spec.ts`, while what `createChat` does with the
    // answer is this spec's, and nothing else drives `createChat` at all.
    //
    // `notice: null` and not `''`: the contract is `string | null`, and the
    // service gates the system row on `notice !== null`, so an empty string is
    // TRUTHY there — a double returning one can never reach the no-notice
    // branch, and would have written a blank system row into every import.
    {
      prepare: async () => undefined,
      importHistory: async () => ({ events: [], notice: null }),
      ...opts.cliSessions,
    } as unknown as CliSessionsService,
    // The REAL service over the real adapter registry: it reads the run's own
    // cwd off disk, and every run these tests create sits in a temp directory
    // that pins nothing — so the honest answer is the null the production path
    // gives, and a double would pin the double instead.
    new ConfigDirPinService(adapters),
    // The REAL broker: it is a rendezvous with no I/O, and what these tests
    // observe through it — that a host-asked question reaches the same card
    // and the same verdict path a CLI-asked one does — is exactly what a
    // double would have to fake.
    userQuestions,
    // Real, for the reason the question broker above is: what these tests
    // observe through it is the row a report actually persists.
    findingsReports,
    callTokens,
    {
      token: 'launch',
      version: '0.0.0',
      startedAt: 0,
      port: opts.port === undefined ? 4870 : opts.port,
    },
    // Most tests toggle nothing, so the default points at a path that never
    // exists — a mkdtemp per setup() would leak one directory per TEST. The
    // tests that DO exercise the switch pass a real file.
  );
  // Nest calls this for us in production; a hand-built service gets it here so
  // every spec runs against the same wiring rather than a subset of it.
  service.onModuleInit();
  return {
    service,
    deltas,
    partials,
    callTokens,
    userQuestions,
    findingsReports,
    statuses,
    deletedRuns,
    removedAttachmentRuns,
    runDao,
    itemDao,
    nodeDao,
    published,
    registry,
    sessions,
    approvals,
    claude,
    cursor,
    efforts,
    claudeProbe,
    skillHarvest,
    mcpHarvest,
    assertedGroups,
  };
}

describe('ChatService', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'geniro-chat-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('createChat rejects a missing cwd and stores the canonical path', async () => {
    const { service } = setup();
    await expect(
      service.createChat({ agentKind: 'claude', cwd: '/definitely/not/here' }),
    ).rejects.toThrow();

    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    expect(run.agentKind).toBe('claude');
    expect(run.status).toBe('pending');
    expect(run.cwd).toBe(realpathSync(dir));
  });

  describe('createChat taking over a conversation the CLI already holds', () => {
    /** The three ordering invariants the adoption path states about itself. */
    it('leaves NO run behind when the CLI refuses the session', async () => {
      // The whole reason `prepare` runs before `runDao.create`. A CLI can
      // refuse — the session was deleted, or it lives under another profile —
      // and the user must get that sentence rather than a chat whose first
      // message dies on a session nobody can find. Move `prepare` below the
      // create and this is the only assertion that notices.
      const { service, runDao } = setup({
        cliSessions: {
          prepare: async () => {
            throw new Error('no such session');
          },
        },
      });

      await expect(
        service.createChat({
          agentKind: 'claude',
          cwd: dir,
          resumeSessionId: 'sess-1',
        }),
      ).rejects.toThrow('no such session');
      expect([...runDao.runs.values()]).toEqual([]);
    });

    it('writes the notice FIRST, then the conversation, in one ascending run of seqs', async () => {
      const { service, itemDao } = setup({
        cliSessions: {
          importHistory: async () => ({
            events: [
              { type: 'user_message', text: 'what is 2+2?' },
              { type: 'text', text: '4' },
            ],
            notice: 'Older messages were left out.',
          }),
        },
      });

      const run = await service.createChat({
        agentKind: 'claude',
        cwd: dir,
        resumeSessionId: 'sess-1',
      });

      const items = itemDao.items.filter((item) => item.runId === run.id);
      expect(
        items.map((item) => [item.kind, item.role, JSON.parse(item.payload)]),
      ).toEqual([
        [
          'system',
          null,
          { message: 'Older messages were left out.', severity: 'info' },
        ],
        ['message', 'user', { text: 'what is 2+2?' }],
        ['message', 'assistant', { text: '4' }],
      ]);
      // The notice is at the transcript's HEAD, and the imported turns follow
      // it in the order they were said — an allocator handing out seqs in a
      // different order would put the explanation in the middle of the
      // conversation it is explaining.
      expect(items.map((item) => item.seq)).toEqual([0, 1, 2]);
    });

    it('writes no system row at all when there is nothing to report', async () => {
      // The happy path's own rule: the transcript is its own evidence that the
      // import worked, so only what the transcript cannot show earns a line.
      const { service, itemDao } = setup({
        cliSessions: {
          importHistory: async () => ({
            events: [{ type: 'text', text: 'carried over' }],
            notice: null,
          }),
        },
      });

      const run = await service.createChat({
        agentKind: 'claude',
        cwd: dir,
        resumeSessionId: 'sess-1',
      });

      const items = itemDao.items.filter((item) => item.runId === run.id);
      expect(items.map((item) => item.kind)).toEqual(['message']);
    });

    it('skips an event that maps to no row rather than writing a blank one', async () => {
      // `mapEventToItem` answers null for the ephemeral live plane, which a
      // history read has no business carrying — but the loop's `continue` is
      // reachable and unpinned otherwise, and dropping it writes rows with no
      // kind into an imported transcript.
      const { service, itemDao } = setup({
        cliSessions: {
          importHistory: async () => ({
            events: [
              { type: 'text_delta', text: 'par' },
              { type: 'text', text: 'the only row' },
            ],
            notice: null,
          }),
        },
      });

      const run = await service.createChat({
        agentKind: 'claude',
        cwd: dir,
        resumeSessionId: 'sess-1',
      });

      const items = itemDao.items.filter((item) => item.runId === run.id);
      expect(items.map((item) => JSON.parse(item.payload))).toEqual([
        { text: 'the only row' },
      ]);
      // Seqs are allocated per PERSISTED row, so the skipped event leaves no
      // hole for a later `afterSeq` cursor to stall on.
      expect(items.map((item) => item.seq)).toEqual([0]);
    });

    it('records the session id where the next turn already looks for one', async () => {
      // The import is not a second kind of thread: the id goes on `node_state`,
      // the same row a live turn writes and reads, so nothing about resuming
      // has to know this chat began as an import.
      const { service, nodeDao } = setup();
      const run = await service.createChat({
        agentKind: 'claude',
        cwd: dir,
        resumeSessionId: 'sess-1',
      });

      expect(nodeDao.savedFor).toEqual([
        { runId: run.id, nodeId: SINGLE_AGENT_NODE, sessionId: 'sess-1' },
      ]);
    });

    it('touches none of it for an ordinary new chat', async () => {
      const prepare = vi.fn(async () => undefined);
      const { service, itemDao } = setup({ cliSessions: { prepare } });

      const run = await service.createChat({ agentKind: 'claude', cwd: dir });

      expect(prepare).not.toHaveBeenCalled();
      expect(itemDao.items.filter((item) => item.runId === run.id)).toEqual([]);
    });
  });

  it('files a new chat into the group whose folder claims it', async () => {
    const { service, runDao } = setup({ autoGroupId: 'g-work' });
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    expect(run.groupId).toBe('g-work');
    // On the ROW, not just the answer — the sidebar reads it back from a list
    // fetch on the next launch, not from this response.
    expect(runDao.runs.get(run.id)?.groupId).toBe('g-work');
  });

  it('leaves a new chat loose when no group claims its folder', async () => {
    const { service } = setup();
    expect(
      (await service.createChat({ agentKind: 'claude', cwd: dir })).groupId,
    ).toBeNull();
  });

  it('setGroup files a run, and null takes it back out', async () => {
    const { service, assertedGroups } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    expect((await service.setGroup(run.id, 'g-work')).groupId).toBe('g-work');
    // The group is CHECKED before the write: a dangling id renders exactly like
    // a run that never moved, so the refusal has to happen here or not at all.
    expect(assertedGroups).toEqual(['g-work']);
    expect((await service.setGroup(run.id, null)).groupId).toBeNull();
    // Null names no group, so there is nothing to check — one assertion still.
    expect(assertedGroups).toEqual(['g-work']);
  });

  describe('host question channel', () => {
    async function settle(agent: {
      emit: (e: AgentEvent) => void;
      finish: () => void;
    }): Promise<void> {
      agent.emit({
        type: 'turn_complete',
        usage: null,
        stopReason: 'end_turn',
        finalText: null,
      });
      agent.finish();
      await drain();
      await drain();
    }

    it('hands a cursor turn geniro’s own question tool, and lets it be asked', async () => {
      const { service, cursor, userQuestions, callTokens } = setup();
      const run = await service.createChat({
        agentKind: 'cursor-agent',
        cwd: dir,
      });
      await service.sendMessage(run.id, 'hello');

      const startArg = cursor.start.mock.calls[0]?.[0] as AgentTurnInput;
      expect(startArg.mcpEndpoint?.url).toContain(
        `/v1/mcp/${run.id}/${SINGLE_AGENT_NODE}`,
      );
      // The endpoint is only usable with a token the guard will accept on that
      // route, so an endpoint whose token was never issued is a tool the agent
      // is told about and refused at.
      expect(startArg.mcpEndpoint?.token).toBe(
        callTokens.get(run.id, SINGLE_AGENT_NODE),
      );
      expect(userQuestions.canAsk(run.id, SINGLE_AGENT_NODE)).toBe(true);
      await settle(cursor);
    });

    it('publishes no endpoint and mints no token when the daemon has no port', async () => {
      // With nothing bound there is no URL to hand the CLI, so a token would be
      // a credential nobody can present — registered as a redaction secret and
      // held to run teardown for a route that does not exist.
      const { service, claude, findingsReports, callTokens } = setup({
        port: null,
      });
      const run = await service.createChat({ agentKind: 'claude', cwd: dir });
      await service.sendMessage(run.id, 'hello');

      const startArg = claude.start.mock.calls[0]?.[0] as AgentTurnInput;
      expect(startArg.mcpEndpoint ?? null).toBeNull();
      expect(callTokens.get(run.id, SINGLE_AGENT_NODE)).toBeNull();
      expect(findingsReports.canReport(run.id, SINGLE_AGENT_NODE)).toBe(false);
      await settle(claude);
    });

    it('hands a cursor turn the findings tool too — every chat can draw a card', async () => {
      const { service, cursor, findingsReports } = setup();
      const run = await service.createChat({
        agentKind: 'cursor-agent',
        cwd: dir,
      });
      await service.sendMessage(run.id, 'hello');

      expect(findingsReports.canReport(run.id, SINGLE_AGENT_NODE)).toBe(true);
      await settle(cursor);
    });

    it('hands a claude turn the endpoint for findings — but never a second question tool', async () => {
      const { service, claude, userQuestions, findingsReports, callTokens } =
        setup();
      const run = await service.createChat({ agentKind: 'claude', cwd: dir });
      await service.sendMessage(run.id, 'hello');

      const startArg = claude.start.mock.calls[0]?.[0] as AgentTurnInput;
      expect(startArg.mcpEndpoint?.url).toContain(
        `/v1/mcp/${run.id}/${SINGLE_AGENT_NODE}`,
      );
      expect(startArg.mcpEndpoint?.token).toBe(
        callTokens.get(run.id, SINGLE_AGENT_NODE),
      );
      expect(findingsReports.canReport(run.id, SINGLE_AGENT_NODE)).toBe(true);
      // The invariant the grant has always carried, and the whole reason it is
      // a union of reasons rather than one flag: claude's own model can ask, so
      // geniro's question tool is never registered beside its own.
      expect(userQuestions.canAsk(run.id, SINGLE_AGENT_NODE)).toBe(false);
      await settle(claude);
    });

    it('answers a report it could not write without naming the database', async () => {
      // The reason reaches a model whose provider is off this machine, and a
      // persist failure names an absolute database path — so it is logged here
      // and replaced with a fixed sentence. The MCP host's own error path
      // refuses to hand its message across for the same reason.
      const { service, claude, findingsReports, itemDao } = setup();
      const run = await service.createChat({ agentKind: 'claude', cwd: dir });
      await service.sendMessage(run.id, 'hello');
      const before = itemDao.items.length;
      itemDao.failNextKind = 'report_findings';

      const outcome = await findingsReports.report(run.id, SINGLE_AGENT_NODE, {
        findings: [{ file: 'src/a.ts', summary: 'A guard was weakened' }],
      });

      expect(outcome).toEqual({
        status: 'unavailable',
        reason: 'the transcript row could not be written',
      });
      expect(itemDao.items).toHaveLength(before);
      await settle(claude);
    });

    it('records a findings report as one transcript row, and nothing else', async () => {
      const { service, claude, findingsReports, itemDao } = setup();
      const run = await service.createChat({ agentKind: 'claude', cwd: dir });
      await service.sendMessage(run.id, 'hello');
      const before = itemDao.items.length;

      // EVERY optional field, deliberately: the payload is `z.unknown()` on the
      // wire, so no type spans this boundary and the renderer's reader
      // (`chats/findings-payload.ts`) is an independent twin. A key that only
      // one side spells is a field that silently vanishes from the card, and
      // this literal is the one place both sides can be checked against the
      // same worked example.
      const outcome = await findingsReports.report(run.id, SINGLE_AGENT_NODE, {
        level: 'high',
        findings: [
          {
            file: 'src/a.ts',
            line: 12,
            summary: 'A guard was weakened',
            shortSummary: 'guard weakened',
            failureScenario: 'A late writer wins the race.',
            category: 'correctness',
            verdict: 'CONFIRMED',
            outcome: 'fixed',
          },
        ],
      });
      await drain();

      expect(outcome).toEqual({ status: 'recorded', count: 1 });
      const rows = itemDao.items.filter(
        (item) => item.kind === 'report_findings',
      );
      expect(rows).toHaveLength(1);
      // "and nothing else", asserted rather than left to the title: a stray row
      // of any other kind slips straight past a filtered count.
      expect(itemDao.items).toHaveLength(before + 1);
      // The payload IS the card — the tool call answers with a receipt alone,
      // so anything missing here is missing from the transcript for good. Read
      // back through JSON because that is how the row actually stores it, which
      // is also the shape the renderer's twin parser has to survive.
      expect(JSON.parse(String(rows[0]?.payload))).toEqual({
        level: 'high',
        findings: [
          {
            file: 'src/a.ts',
            line: 12,
            summary: 'A guard was weakened',
            shortSummary: 'guard weakened',
            failureScenario: 'A late writer wins the race.',
            category: 'correctness',
            verdict: 'CONFIRMED',
            outcome: 'fixed',
          },
        ],
      });
      await settle(claude);
    });

    it('stops accepting reports once the turn that could persist them is over', async () => {
      const { service, claude, findingsReports } = setup();
      const run = await service.createChat({ agentKind: 'claude', cwd: dir });
      await service.sendMessage(run.id, 'hello');
      expect(findingsReports.canReport(run.id, SINGLE_AGENT_NODE)).toBe(true);

      await settle(claude);

      expect(findingsReports.canReport(run.id, SINGLE_AGENT_NODE)).toBe(false);
      await expect(
        findingsReports.report(run.id, SINGLE_AGENT_NODE, { findings: [] }),
      ).resolves.toEqual({
        status: 'unavailable',
        reason: 'no turn is running that could record them',
      });
    });

    it('puts a card on screen and returns the verdict’s answer to the agent', async () => {
      const { service, cursor, userQuestions, approvals, itemDao } = setup();
      const run = await service.createChat({
        agentKind: 'cursor-agent',
        cwd: dir,
      });
      await service.sendMessage(run.id, 'hello');

      const asked = userQuestions.ask(
        run.id,
        SINGLE_AGENT_NODE,
        [{ question: 'Which database?', options: [{ label: 'Postgres' }] }],
        null,
      );
      await drain();

      // The SAME card a CLI-raised question puts: one approval_request item,
      // one entry in the shared registry, flagged as a question so the badge
      // says the agent is asking rather than waiting on a permission.
      const card = itemDao.items.find(
        (item) => item.kind === 'approval_request',
      );
      expect(card).toBeDefined();
      expect(card?.payload).toContain(HOST_QUESTION_TOOL);
      const pending = approvals.listByRun(run.id);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.question).toBe(true);

      expect(
        approvals.resolve(run.id, pending[0]!.requestId, true, 'Postgres'),
      ).toBe(true);
      expect(await asked).toEqual({ status: 'answered', answer: 'Postgres' });
      await drain();
      expect(
        itemDao.items.some(
          (item) =>
            item.kind === 'approval_verdict' &&
            item.payload.includes('Postgres'),
        ),
      ).toBe(true);
      await settle(cursor);
    });

    it('answers an ask left parked when the turn ends, instead of leaving it hanging', async () => {
      const { service, cursor, userQuestions } = setup();
      const run = await service.createChat({
        agentKind: 'cursor-agent',
        cwd: dir,
      });
      await service.sendMessage(run.id, 'hello');

      const asked = userQuestions.ask(
        run.id,
        SINGLE_AGENT_NODE,
        [{ question: 'Which?', options: [{ label: 'A' }] }],
        null,
      );
      await drain();
      await settle(cursor);

      // `ApprovalRegistry.sweepNode` only DROPS the card; the promise the MCP
      // request is blocked on has to be settled here or that call waits for
      // its own client timeout with the turn long gone.
      expect(await asked).toEqual({
        status: 'unavailable',
        reason: 'the turn ended before the question was answered',
      });
      // …and the asker is gone with the turn, so a later call is refused
      // rather than parked on a card nothing will close.
      expect(userQuestions.canAsk(run.id, SINGLE_AGENT_NODE)).toBe(false);
    });
  });

  describe('geniro commands', () => {
    /** Run one turn to completion, with the agent saying `said`. */
    async function turn(
      agent: { emit: (e: AgentEvent) => void; finish: () => void },
      said: string | null,
      ending: AgentEvent = {
        type: 'turn_complete',
        usage: null,
        stopReason: 'end_turn',
        finalText: null,
      },
    ): Promise<void> {
      if (said !== null) {
        agent.emit({ type: 'text', text: said });
      }
      agent.emit(ending);
      agent.finish();
      // Twice: the finalizer's own chain runs several awaits deep, and the
      // compaction commit is the LAST of them.
      await drain();
      await drain();
    }

    it('sends the CLI its OWN compaction command, and touches no session', async () => {
      // claude rewrites its history in place and keeps the session; dropping it
      // here would discard the conversation the summary was distilled from.
      const { service, claude, nodeDao } = setup();
      const run = await service.createChat({ agentKind: 'claude', cwd: dir });
      await service.sendMessage(run.id, '/compact');

      const startArg = claude.start.mock.calls[0]?.[0] as AgentTurnInput;
      expect(startArg.prompt).toBe('/compact');
      await turn(claude, 'compacted.');
      expect(nodeDao.cleared).toEqual([]);
    });

    it('rewrites the prompt for a CLI that has no compaction of its own', async () => {
      // cursor's `/summarize` is a TUI command its ACP server never advertises,
      // so the literal text would reach the model as prose — which is the
      // reported defect. The TRANSCRIPT still records what the user typed.
      const { service, cursor, itemDao } = setup();
      const run = await service.createChat({
        agentKind: 'cursor-agent',
        cwd: dir,
      });
      const userWire = await service.sendMessage(run.id, '/compact');

      const startArg = cursor.start.mock.calls[0]?.[0] as AgentTurnInput;
      expect(startArg.prompt).not.toBe('/compact');
      expect(startArg.prompt).toMatch(/summar/i);
      expect((userWire.payload as { text: string }).text).toBe('/compact');
      expect(
        itemDao.items.some(
          (item) => item.role === 'user' && item.payload.includes('/compact'),
        ),
      ).toBe(true);
      await turn(cursor, 'the summary');
    });

    it('drops the session and carries the summary into the next turn', async () => {
      const { service, cursor, nodeDao, runDao, itemDao } = setup();
      const run = await service.createChat({
        agentKind: 'cursor-agent',
        cwd: dir,
      });
      await service.sendMessage(run.id, '/compact');
      cursor.emit({ type: 'session', sessionId: 'sess-1' });
      // A reading of the conversation about to be discarded — without one the
      // null below would hold whether or not anything cleared it.
      cursor.emit({
        type: 'context_progress',
        contextTokens: 101_500,
        contextWindowTokens: 1_000_000,
      });
      await turn(cursor, 'we agreed on plan B');

      expect(nodeDao.cleared).toEqual([
        { runId: run.id, nodeId: SINGLE_AGENT_NODE },
      ]);
      expect((await runDao.getById(run.id))?.pendingContext).toBe(
        'we agreed on plan B',
      );
      // The context READING goes with the conversation it measured. Reported
      // as "после компакта кружочек не обновляется. Он все еще так же заполнен
      // с контекстом": nothing measures the replacement until the next turn
      // runs, so a figure left standing here is the ring's newest source and
      // it describes a conversation that has been discarded.
      expect((await runDao.getById(run.id))?.contextTokens).toBeNull();
      // `severity: 'info'` with it: this row reports the thing the user ASKED
      // for having worked, and the renderer reads an absent severity as the
      // loud failure chrome every other daemon notice wears — which drew a
      // successful compaction as a red warning.
      expect(
        itemDao.items.some(
          (item) =>
            item.kind === 'system' &&
            item.payload.includes('Conversation compacted') &&
            item.payload.includes('"severity":"info"'),
        ),
      ).toBe(true);

      // The NEXT turn opens on a fresh session carrying the summary — once.
      await service.sendMessage(run.id, 'now do it');
      const next = cursor.start.mock.calls[1]?.[0] as AgentTurnInput;
      expect(next.resumeSessionId).toBeNull();
      expect(next.prompt).toContain('we agreed on plan B');
      expect(next.prompt.endsWith('now do it')).toBe(true);
      expect((await runDao.getById(run.id))?.pendingContext).toBeNull();
      await turn(cursor, 'done');

      await service.sendMessage(run.id, 'and again');
      const third = cursor.start.mock.calls[2]?.[0] as AgentTurnInput;
      expect(third.prompt).toBe('and again');
      await turn(cursor, 'ok');
    });

    it('abandons the compaction — and SAYS so — when the turn did not finish', async () => {
      // Destroying the conversation on the strength of a turn the user stopped
      // partway through the summary costs everything and buys nothing.
      const { service, cursor, nodeDao, runDao, itemDao } = setup();
      const run = await service.createChat({
        agentKind: 'cursor-agent',
        cwd: dir,
      });
      await service.sendMessage(run.id, '/compact');
      cursor.emit({
        type: 'context_progress',
        contextTokens: 101_500,
        contextWindowTokens: 1_000_000,
      });
      await turn(cursor, 'half a par', { type: 'turn_cancelled' });

      expect(nodeDao.cleared).toEqual([]);
      expect((await runDao.getById(run.id))?.pendingContext).toBeFalsy();
      // The conversation is intact, so its reading is too — the clear belongs
      // to the COMMIT, not to the word `/compact`.
      expect((await runDao.getById(run.id))?.contextTokens).toBe(101_500);
      expect(
        itemDao.items.some(
          (item) =>
            item.kind === 'system' && item.payload.includes('did not finish'),
        ),
      ).toBe(true);
    });

    it('abandons it when the turn finished saying nothing', async () => {
      const { service, cursor, nodeDao, itemDao } = setup();
      const run = await service.createChat({
        agentKind: 'cursor-agent',
        cwd: dir,
      });
      await service.sendMessage(run.id, '/compact');
      await turn(cursor, null);

      expect(nodeDao.cleared).toEqual([]);
      expect(
        itemDao.items.some(
          (item) =>
            item.kind === 'system' &&
            item.payload.includes('produced no summary'),
        ),
      ).toBe(true);
    });

    it('refuses a geniro command while a turn is running, rather than queueing it', async () => {
      // Handing `/compact` to the running turn would write it into the CLI's
      // own conversation, where the rewrite never happens — and what the user
      // asked to compact is what is being said right now.
      const { service, claude } = setup();
      const run = await service.createChat({ agentKind: 'claude', cwd: dir });
      await service.sendMessage(run.id, 'hello');

      await expect(service.sendMessage(run.id, '/compact')).rejects.toThrow(
        /RUN_BUSY|idle/,
      );
      await turn(claude, 'hi');
    });
  });

  it('setGroup 404s for a run that does not exist', async () => {
    const { service } = setup();
    await expect(service.setGroup('nope', null)).rejects.toThrow(/not found/);
  });

  it('persists the user message then streams the reply with monotonic seq', async () => {
    const { service, runDao, published, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    published.length = 0;

    const userWire = await service.sendMessage(run.id, 'hello');
    expect(userWire).toMatchObject({ kind: 'message', role: 'user', seq: 0 });
    expect(claude.start).toHaveBeenCalledOnce();
    const startArg = claude.start.mock.calls[0]?.[0] as AgentTurnInput;
    expect(startArg.cwd).toBe(realpathSync(dir));
    expect(startArg.prompt).toBe('hello');

    claude.emit({ type: 'text', text: 'hi there' });
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: 'end_turn',
      finalText: null,
    });
    claude.finish();
    await drain();

    expect(
      published.map((e) => `${e.item.seq}:${e.item.kind}/${e.item.role ?? ''}`),
    ).toEqual(['0:message/user', '1:message/assistant', '2:turn_complete/']);
    expect((await runDao.getById(run.id))?.status).toBe('completed');
  });

  it('persists tool-use rows (reasoning/tool_call/tool_result) with their payload fields intact', async () => {
    // A typical turn is a tool-using turn: the persisted kind/role/payload for
    // these rows is what history replay renders, so the exact shape is pinned
    // through the real service path, not just the mapper in isolation.
    const { service, itemDao, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });

    await service.sendMessage(run.id, 'edit the file');
    claude.emit({ type: 'reasoning', text: 'planning the edit' });
    claude.emit({
      type: 'tool_call',
      id: 't1',
      name: 'Read',
      input: { path: '/x' },
    });
    claude.emit({
      type: 'tool_result',
      id: 't1',
      name: null,
      result: 'file body',
      isError: false,
    });
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: 'end_turn',
      finalText: null,
    });
    claude.finish();
    await drain();

    const rows = await itemDao.getByRun(run.id);
    expect(
      rows.map((row) => `${row.seq}:${row.kind}/${row.role ?? ''}`),
    ).toEqual([
      '0:message/user',
      '1:reasoning/assistant',
      '2:tool_call/assistant',
      '3:tool_result/tool',
      '4:turn_complete/',
    ]);
    expect(JSON.parse(rows[1]!.payload)).toEqual({ text: 'planning the edit' });
    expect(JSON.parse(rows[2]!.payload)).toEqual({
      id: 't1',
      name: 'Read',
      input: { path: '/x' },
    });
    // isError must survive persistence — a dropped field breaks replay silently.
    expect(JSON.parse(rows[3]!.payload)).toEqual({
      id: 't1',
      name: null,
      result: 'file body',
      isError: false,
    });
  });

  it('hands a mid-turn message to the running turn instead of refusing it', async () => {
    // Probe-verified on claude 2.1.222: a second user line on a still-open
    // stream-json stdin is picked up at the next tool boundary of the turn
    // already in flight. Refusing (as this used to) meant the message waited
    // for the CLI PROCESS to exit — minutes on a long turn, for a request the
    // user had already replaced.
    const { service, claude, itemDao } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(run.id, 'first'); // turn in flight, not finished

    const item = await service.sendMessage(run.id, 'actually, do this instead');

    expect(claude.handles[0]!.sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'actually, do this instead' }),
    );
    // A SECOND CLI must not have been spawned — it joined the running turn.
    expect(claude.start).toHaveBeenCalledTimes(1);
    // And it is in the transcript, after everything the turn has written.
    expect(item.kind).toBe('message');
    expect(item.role).toBe('user');
    const rows = itemDao.items.filter((row) => row.runId === run.id);
    expect(item.seq).toBe(Math.max(...rows.map((row) => row.seq)));

    claude.finish();
    await drain();
  });

  it('stamps a mid-turn message with nothing that says it was one', async () => {
    // A `midTurn: true` flag used to ride on this payload so the renderer could
    // caption the row; the caption was reported as noise under every such
    // message and removed, and the flag went with it rather than staying as a
    // key nothing reads.
    //
    // Asserted on the mid-turn message specifically — the ONE the flag was ever
    // set on — so re-introducing it here fails rather than passing on the
    // ordinary message that never carried it.
    const { service, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });

    const first = await service.sendMessage(run.id, 'first');
    const followUp = await service.sendMessage(run.id, 'and also this');

    expect(followUp.payload).not.toHaveProperty('midTurn');
    expect(first.payload).not.toHaveProperty('midTurn');
    // The message itself still arrives whole — this removed a caption, not a
    // send.
    expect(followUp.payload).toMatchObject({ text: 'and also this' });

    claude.finish();
    await drain();
  });

  it('gives a mid-turn message a seq the running turn has not already reserved', async () => {
    // THE duplicate-seq defect, reproduced on a real transcript: a user item
    // and the assistant's reply both landed on seq 5927, and the renderer —
    // which de-dupes the replay/live seam BY seq — dropped the second to
    // arrive. That was the agent's answer, so the reported symptom was "it
    // just deletes its last message".
    //
    // It was deterministic, not a race. The turn seeded a closure-local
    // counter from `maxSeq` ONCE and incremented it per item, while this path
    // re-read `maxSeq` from the table — which cannot see a counter's
    // reservations — so it was handed the value the turn had already claimed
    // for its next durable item, on every mid-turn follow-up.
    const { service, claude, itemDao } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(run.id, 'first');

    // The follow-up goes in FIRST, then the turn writes its next item. That
    // order is what the defect needed, and reversing it would pass either way.
    await service.sendMessage(run.id, 'and also this');
    claude.emit({ type: 'text', text: 'on it' });
    claude.finish();
    await drain();

    const rows = await itemDao.getByRun(run.id);
    const seqs = rows.map((row) => row.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    // Not merely unique — the follow-up must sit BEFORE the reply it preceded,
    // or the transcript reads with the answer above the question.
    const followUp = rows.findIndex(
      (row) => JSON.parse(row.payload).text === 'and also this',
    );
    const reply = rows.findIndex(
      (row) => JSON.parse(row.payload).text === 'on it',
    );
    expect(followUp).toBeGreaterThanOrEqual(0);
    expect(reply).toBeGreaterThan(followUp);
  });

  it('refuses with RUN_BUSY when the running turn cannot take one', async () => {
    // ACP's `session/prompt` is one request per turn, so its adapter reports
    // false — and the refusal has to be the SAME RUN_BUSY the caller already
    // queues on, or a CLI without the channel needs special handling upstream.
    const { service, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(run.id, 'first');
    claude.handles[0]!.sendUserMessage.mockReturnValue(false);

    await expect(service.sendMessage(run.id, 'second')).rejects.toMatchObject({
      errorCode: 'RUN_BUSY',
    });

    claude.finish();
    await drain();
  });

  it('writes nothing to the transcript when the delivery is refused', async () => {
    // Order matters: the CLI gets it first, and only a delivery it CONFIRMED
    // is recorded. The reverse leaves a user message on screen that no agent
    // ever received — the silent failure this path exists to replace.
    const { service, claude, itemDao } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(run.id, 'first');
    claude.handles[0]!.sendUserMessage.mockReturnValue(false);
    const before = itemDao.items.filter((row) => row.runId === run.id).length;

    await expect(service.sendMessage(run.id, 'lost?')).rejects.toMatchObject({
      errorCode: 'RUN_BUSY',
    });

    expect(itemDao.items.filter((row) => row.runId === run.id)).toHaveLength(
      before,
    );

    claude.finish();
    await drain();
  });

  it('passes the stored session id to resume and de-dupes repeated session events', async () => {
    const { service, nodeDao, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    nodeDao.preset('prev-sid');

    await service.sendMessage(run.id, 'go');
    const startArg = claude.start.mock.calls[0]?.[0] as AgentTurnInput;
    expect(startArg.resumeSessionId).toBe('prev-sid');

    claude.emit({ type: 'session', sessionId: 'prev-sid' }); // unchanged → skip
    claude.emit({ type: 'session', sessionId: 'new-sid' }); // changed → save
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();

    expect(nodeDao.saved).toEqual(['new-sid']);
  });

  it('records a slash_commands report for the run cwd, off the transcript', async () => {
    const { service, itemDao, claude, skillHarvest } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });

    await service.sendMessage(run.id, 'go');
    claude.emit({
      type: 'slash_commands',
      commands: [
        { name: 'deploy', description: null },
        { name: 'compact', description: null },
      ],
    });
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();

    // Keyed by the agent that reported it as well as the folder — one folder
    // is routinely used by both CLIs.
    expect(skillHarvest.record).toHaveBeenCalledWith(
      'claude',
      realpathSync(dir),
      null,
      [
        { name: 'deploy', description: null },
        { name: 'compact', description: null },
      ],
    );
    // The report never becomes a transcript row — no persisted payload
    // carries the harvested names.
    expect(
      itemDao.items.filter((item) => item.payload.includes('compact')),
    ).toEqual([]);
  });

  it('records an mcp_servers report for the run cwd, off the transcript', async () => {
    // This seam is the whole supply of the MCP harvest: without it the panel
    // falls back to `claude mcp list`, which starts every configured server in
    // order to health-check it. A turn already reported them, for free.
    const { service, itemDao, claude, mcpHarvest } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    const codegraph = {
      name: 'codegraph',
      target: null,
      transport: null,
      status: 'connected' as const,
      detail: null,
    };

    await service.sendMessage(run.id, 'go');
    claude.emit({ type: 'mcp_servers', servers: [codegraph] });
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();

    // Null because THIS chat named no profile — not because a chat cannot have
    // one, which is what this comment used to say. The key must match the one
    // the panel's own read builds, or the harvest is written somewhere nothing
    // ever looks; the profile case is pinned directly below.
    expect(mcpHarvest.record).toHaveBeenCalledWith(
      'claude',
      realpathSync(dir),
      null,
      [codegraph],
    );
    expect(
      itemDao.items.filter((item) => item.payload.includes('codegraph')),
    ).toEqual([]);
  });

  it('files that report under the chat’s OWN profile, not the default one', async () => {
    // A profile is a separate ACCOUNT with its own servers. Filing every chat's
    // report under `null` was wrong in both directions: the profile's own panel
    // found no harvest and paid the full cold dial (~30s on a 47-server
    // account), while the DEFAULT profile's panel was painted with the other
    // subscription's servers. Measured on this machine — 15 rows belonging to
    // `.claude-manifest-lab-personal` shown where the default profile's own
    // dial found 10.
    const { service, claude, mcpHarvest } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      configDir: dir,
    });
    const codegraph = {
      name: 'codegraph',
      target: null,
      transport: null,
      status: 'connected' as const,
      detail: null,
    };

    await service.sendMessage(run.id, 'go');
    claude.emit({ type: 'mcp_servers', servers: [codegraph] });
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();

    expect(mcpHarvest.record).toHaveBeenCalledWith(
      'claude',
      realpathSync(dir),
      realpathSync(dir),
      [codegraph],
    );
  });

  it('synthesizes a turn_complete when the turn ends with no terminal event', async () => {
    const { service, runDao, published, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    published.length = 0;

    await service.sendMessage(run.id, 'go');
    claude.emit({ type: 'text', text: 'partial' }); // no terminal event arrives
    claude.finish();
    await drain();

    expect(published.at(-1)?.item.kind).toBe('turn_complete');
    expect((await runDao.getById(run.id))?.status).toBe('completed');
  });

  it('marks the run failed instead of synthesizing success after an event persistence failure', async () => {
    const { service, runDao, itemDao, published, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    published.length = 0;
    itemDao.failNextKind = 'turn_complete';

    await service.sendMessage(run.id, 'go');
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: 'end_turn',
      finalText: null,
    });
    claude.finish();
    await drain();

    expect((await runDao.getById(run.id))?.status).toBe('failed');
    expect(published.some((event) => event.item.kind === 'turn_complete')).toBe(
      false,
    );
    expect(published.at(-1)?.item.kind).toBe('error');
  });

  it('denies the parked CLI (never hangs) when an approval_request card fails to persist', async () => {
    // persist-then-emit means a failed card write leaves NO card for the user
    // to answer AND the ask-mode CLI parked on stdin waiting for a verdict.
    // Without a deny-to-unblock the turn wedges forever — handle.done never
    // resolves (a parked turn never exits), so the finalizer never runs. Pin
    // that the CLI is auto-denied so the run settles instead of hanging.
    const { service, runDao, itemDao, claude } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      approval: 'ask',
    });
    await service.sendMessage(run.id, 'go');
    itemDao.failNextKind = 'approval_request';
    claude.emit({
      type: 'approval_request',
      id: 'req-1',
      toolName: 'Write',
      input: { file_path: 'a.txt' },
    });
    await drain();

    // The parked CLI was unblocked with a denial — not left hanging.
    expect(claude.handles[0]?.respondApproval).toHaveBeenCalledWith(
      'req-1',
      false,
      undefined,
    );

    // Once the now-unblocked CLI exits, the run settles as failed (not stuck).
    claude.finish();
    await drain();
    expect((await runDao.getById(run.id))?.status).toBe('failed');
  });

  it('marks the run failed and releases its claim when adapter start throws', async () => {
    const { service, runDao, registry, claude, findingsReports } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    claude.start.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });

    await expect(service.sendMessage(run.id, 'go')).rejects.toThrow(
      'spawn failed',
    );

    expect((await runDao.getById(run.id))?.status).toBe('failed');
    expect(registry.has(run.id)).toBe(false);
    // The host tools are registered BEFORE the spawn, and this is the only path
    // that can take them down again — the turn finalizer never runs. Left
    // registered, the tools stay listed on the run's own MCP endpoint with no
    // turn behind them for the rest of the launch.
    expect(findingsReports.canReport(run.id, SINGLE_AGENT_NODE)).toBe(false);
  });

  it('rejects sendMessage for an unknown run', async () => {
    const { service } = setup();
    await expect(service.sendMessage('nope', 'hi')).rejects.toThrow();
  });

  it('maps an error event to failed, releases the slot, and accepts a follow-up send', async () => {
    const { service, runDao, registry, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });

    await service.sendMessage(run.id, 'go');
    claude.emit({ type: 'error', message: 'boom' });
    claude.finish();
    await drain();

    expect((await runDao.getById(run.id))?.status).toBe('failed');
    expect(registry.has(run.id)).toBe(false);
    // Slot released → the next send is NOT rejected RUN_BUSY.
    await expect(service.sendMessage(run.id, 'again')).resolves.toMatchObject({
      role: 'user',
    });
    claude.finish();
    await drain();
  });

  it('runs a chat’s second message on the process the first one left running', async () => {
    // The user-visible complaint behind item 11: a CLI boots the user's MCP
    // servers when it starts, and one of them can own a browser they are
    // logged into. A process per turn tore that down on every message —
    // measured at two full boots of all ten servers for two messages, plus
    // 6.5s of startup before the second turn produced a token.
    const { service, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });

    await service.sendMessage(run.id, 'first');
    claude.finish();
    await drain();

    await service.sendMessage(run.id, 'second');
    claude.finish();
    await drain();

    // Two turns…
    expect(claude.start).toHaveBeenCalledTimes(2);
    // …on ONE process.
    expect(claude.sessions).toHaveLength(1);
    expect(claude.sessions[0]?.closed).toBe(false);
  });

  it('closes the chat’s CLI process when the chat is deleted', async () => {
    // Cancelling the turn stops the WORK and deliberately leaves the process
    // running — that is what a run-scoped session is for. So a delete that did
    // not close it would strand a CLI, and every MCP server it started, under
    // a run nothing can ever reach again.
    const { service, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(run.id, 'go');
    claude.finish();
    await drain();

    expect(claude.sessions).toHaveLength(1);
    expect(claude.sessions[0]?.closed).toBe(false);

    await service.delete(run.id);

    expect(claude.sessions[0]?.closed).toBe(true);
  });

  it('maps a turn_cancelled event to cancelled status', async () => {
    const { service, runDao, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });

    await service.sendMessage(run.id, 'go');
    claude.emit({ type: 'turn_cancelled' });
    claude.finish();
    await drain();

    expect((await runDao.getById(run.id))?.status).toBe('cancelled');
  });

  it('cancel() cancels the in-flight handle and reports it; an unknown run throws', async () => {
    const { service, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });

    await service.sendMessage(run.id, 'go'); // turn in flight, registered
    const started = claude.start.mock.results[0]?.value as {
      cancel: ReturnType<typeof vi.fn>;
    };

    await expect(service.cancel(run.id)).resolves.toEqual({ cancelled: true });
    expect(started.cancel).toHaveBeenCalledOnce();

    await expect(service.cancel('nope')).rejects.toThrow();

    claude.finish();
    await drain();
  });

  it('cancel() rejects a workflow run — never cancels the other kind silently', async () => {
    const { service, runDao, registry } = setup();
    const run = await runDao.create({ workflowId: 'wf-1', status: 'running' });
    registry.tryClaim(run.id);
    const cancelled = vi.fn();
    registry.register(run.id, {
      done: Promise.resolve(),
      cancel: cancelled,
      respondApproval: () => false,
      sendUserMessage: () => false,
      setApprovalMode: () => false,
    });

    await expect(service.cancel(run.id)).rejects.toThrow(
      /NOT_A_CHAT_RUN|not a single-agent chat/,
    );
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('createChat rejects a relative cwd and a path that is not a directory', async () => {
    const { service } = setup();
    await expect(
      service.createChat({ agentKind: 'claude', cwd: 'relative/path' }),
    ).rejects.toThrow();

    const filePath = join(dir, 'not-a-dir.txt');
    writeFileSync(filePath, 'x');
    await expect(
      service.createChat({ agentKind: 'claude', cwd: filePath }),
    ).rejects.toThrow();
  });

  it('createChat canonicalizes a config directory and refuses a bad one', async () => {
    const { service } = setup();
    const configDir = mkdtempSync(join(dir, 'plugins-'));
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      configDir,
    });
    // Canonical, like `cwd`: what the turn spawns with must be what was
    // checked, so a symlink re-pointed afterwards cannot smuggle another path.
    expect(run.configDir).toBe(realpathSync(configDir));

    await expect(
      service.createChat({
        agentKind: 'claude',
        cwd: dir,
        configDir: join(dir, 'no-such-plugin-dir'),
      }),
    ).rejects.toThrow(/INVALID_CONFIG_DIR|Config directory/);
  });

  it('snapshots the custom instructions onto the run and spawns every turn with them', async () => {
    // The producer half of the feature — the chat path is what puts the user's
    // instructions on the turn input at all, so without this the adapters have
    // nothing to compose however correctly they compose it.
    const { service, claude } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      customInstructions: 'Always answer in British English.',
    });

    await service.sendMessage(run.id, 'go');
    expect(claude.start.mock.calls[0]?.[0].customInstructions).toBe(
      'Always answer in British English.',
    );
  });

  it('snapshots the Max Mode choice onto the run, including OFF', async () => {
    // The producer half again, and `false` is the case worth pinning: the
    // adapter reads an ABSENT choice as its own default (ON), so a user who
    // switched Max Mode off must reach the turn as an explicit `false` rather
    // than as silence. Cursor bills it at the API rate plus 20% on legacy
    // plans, so the difference between "declined" and "did not say" is money.
    const { service, cursor } = setup();
    const run = await service.createChat({
      agentKind: 'cursor-agent',
      cwd: dir,
      cursorMaxMode: false,
    });

    await service.sendMessage(run.id, 'go');
    expect(cursor.start.mock.calls[0]?.[0].cursorMaxMode).toBe(false);
  });

  it('says NOTHING about Max Mode for a run created before the setting', async () => {
    // A row whose column is null predates the choice. It must not reach the
    // turn as `false` — every such run has always used Max Mode, and reading
    // absence as a decline would quietly shrink every existing cursor
    // conversation's window.
    const { service, cursor } = setup();
    const run = await service.createChat({
      agentKind: 'cursor-agent',
      cwd: dir,
    });

    await service.sendMessage(run.id, 'go');
    expect(cursor.start.mock.calls[0]?.[0].cursorMaxMode).toBeUndefined();
  });

  it('normalizes blank custom instructions to nothing at all', async () => {
    // A cleared textarea sends '' rather than omitting the key, and the two
    // must land as one state — otherwise the adapter composes around an empty
    // part and the turn carries a stray blank paragraph.
    const { service, claude } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      customInstructions: '   \n  ',
    });

    await service.sendMessage(run.id, 'go');
    expect(claude.start.mock.calls[0]?.[0].customInstructions).toBeUndefined();
  });

  it('reads the instructions off the run row, not off the newest run', async () => {
    // Narrowed from a "snapshot survives a settings edit" claim this level
    // cannot make: the daemon never opens settings.json, so no live-read
    // implementation exists here for such a test to distinguish. What IS
    // verifiable at this seam is that a turn resolves its instructions from
    // its OWN run row — a service that read the latest run, or a cached value
    // shared across runs, fails below. The user-visible half of the snapshot
    // contract is pinned in the renderer, where the setting is actually read.
    const { service, claude } = setup();
    const first = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      customInstructions: 'ORIGINAL',
    });
    // The user edits Settings, then a second chat is opened on the new text.
    await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      customInstructions: 'EDITED',
    });

    // The FIRST chat's next turn still spawns on the text it was created with.
    await service.sendMessage(first.id, 'go');
    expect(claude.start.mock.calls[0]?.[0].customInstructions).toBe('ORIGINAL');
  });

  it('forgets the snapshotted instructions on EVERY run that held one', async () => {
    // The escape hatch the snapshot design otherwise lacks. Scoped to every
    // run rather than the unsettled ones on purpose: a settled chat is one
    // whose last turn ENDED, not one that is closed — it can be continued at
    // any time, and that turn would re-send the retracted text. A count comes
    // back so the UI can say what the press reached.
    const { service, claude } = setup();
    const first = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      customInstructions: 'REGRETTED',
    });
    await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      customInstructions: 'REGRETTED',
    });
    await service.createChat({ agentKind: 'claude', cwd: dir });

    // Only the two that actually hold a value are counted.
    expect(await service.forgetCustomInstructions()).toEqual({ cleared: 2 });

    // And the next turn of an EXISTING chat no longer carries it.
    await service.sendMessage(first.id, 'go');
    expect(claude.start.mock.calls[0]?.[0].customInstructions).toBeUndefined();
  });

  it('createChat refuses a config directory on a CLI that cannot load one', async () => {
    const { service } = setup();
    const configDir = mkdtempSync(join(dir, 'plugins-'));
    // The refusal carries the ADAPTER's own sentence — the chat picks its
    // directory interactively, so "no" beats a field that silently does
    // nothing (the workflow executor strips instead, and says why).
    await expect(
      service.createChat({
        agentKind: 'cursor-agent',
        cwd: dir,
        configDir,
      }),
    ).rejects.toThrow(/CONFIG_DIR_UNSUPPORTED|cursor/i);

    // Same CLI, no config directory asked for: nothing to refuse.
    const run = await service.createChat({
      agentKind: 'cursor-agent',
      cwd: dir,
    });
    expect(run.configDir).toBeNull();
  });

  it('spawns the turn with the chat’s config directory, and refuses once it is gone', async () => {
    const { service, claude } = setup();
    const configDir = mkdtempSync(join(dir, 'plugins-'));
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      configDir,
    });

    await service.sendMessage(run.id, 'go');
    expect(claude.start.mock.calls[0]?.[0].configDir).toBe(
      realpathSync(configDir),
    );
    claude.emit({
      type: 'turn_complete',
      finalText: 'done',
      usage: null,
      stopReason: null,
    });
    claude.finish();
    await drain();

    // Deleted between turns. The CLI SILENTLY ignores a missing --plugin-dir,
    // so a turn that ran anyway would look like the plugins had nothing to
    // offer; the send is refused instead.
    rmSync(configDir, { recursive: true, force: true });
    await expect(service.sendMessage(run.id, 'again')).rejects.toThrow(
      /INVALID_CONFIG_DIR|Config directory/,
    );
    expect(claude.start).toHaveBeenCalledTimes(1);
  });

  it('reconciles an orphaned running run to failed with a terminal item on boot', async () => {
    const { service, runDao, itemDao } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    // Simulate a crash / SIGKILL mid-turn: left running, no registry handle.
    await runDao.updateById(run.id, { status: 'running' });

    await service.reconcileOrphanedRuns();

    expect((await runDao.getById(run.id))?.status).toBe('failed');
    const items = await itemDao.getByRun(run.id);
    expect(items.at(-1)?.kind).toBe('error');
  });

  it('boot reconcile closes cards a KILLED daemon never swept, and leaves answered ones alone', async () => {
    // The registry is in-memory, so a SIGKILL takes every pending entry with
    // it and no settle path ever runs. Without this the cards come back on
    // the next launch looking answerable forever — the transcript is the only
    // surviving record of which ones were still open.
    const { service, runDao, itemDao } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    // What the KILLED process left on disk: a run stuck 'running', two cards,
    // one of them already answered — and no registry entry in THIS process,
    // which is the whole difference from a live turn.
    for (const [seq, kind, payload] of [
      [0, 'approval_request', { id: 'req-open', toolName: 'Bash' }],
      [1, 'approval_request', { id: 'req-answered', toolName: 'Write' }],
      [2, 'approval_verdict', { id: 'req-answered', allow: true }],
    ] as const) {
      await itemDao.create({
        runId: run.id,
        seq,
        kind,
        payload: JSON.stringify(payload),
      });
    }
    await runDao.updateById(run.id, { status: 'running' });

    await service.reconcileOrphanedRuns();

    const dead = (await itemDao.getByRun(run.id))
      .filter((i) => i.kind === 'unanswerable')
      .map((i) => JSON.parse(i.payload));
    expect(dead).toEqual([{ id: 'req-open', toolName: 'Bash' }]);
  });

  it('reconcile SKIPS a running run whose turn is legitimately in flight', async () => {
    const { service, runDao, itemDao, registry } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await runDao.updateById(run.id, { status: 'running' });
    // A live registry claim marks the turn as owned by THIS process — boot
    // reconcile must not declare it orphaned and kill its transcript.
    registry.tryClaim(run.id);

    await service.reconcileOrphanedRuns();

    expect((await runDao.getById(run.id))?.status).toBe('running');
    expect(await itemDao.getByRun(run.id)).toHaveLength(0);
    registry.release(run.id);
  });

  it('rejects with RUN_STOPPING when shutdown starts inside the claim→spawn window', async () => {
    const { service, runDao, itemDao, registry, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    // Trip shutdown DURING sendMessage's awaited maxSeq — after the claim,
    // before the pre-spawn canStart check — the exact window the guard exists
    // for. A CLI spawned past it would orphan on the imminent process exit.
    const realMaxSeq = itemDao.maxSeq.bind(itemDao);
    vi.spyOn(itemDao, 'maxSeq').mockImplementationOnce(async (...args) => {
      void registry.onApplicationShutdown();
      return realMaxSeq(...(args as Parameters<typeof realMaxSeq>));
    });

    await expect(service.sendMessage(run.id, 'too late')).rejects.toThrow(
      /RUN_STOPPING|shutdown/,
    );

    expect(claude.start).not.toHaveBeenCalled();
    expect((await runDao.getById(run.id))?.status).toBe('failed');
  });

  it('listChats enriches each run with its latest message text and updatedAt', async () => {
    const { service, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });

    await service.sendMessage(run.id, 'first question');
    claude.emit({ type: 'text', text: 'the reply' });
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();

    const listed = await service.listChats();
    const wire = listed.find((r) => r.id === run.id);
    // The LATEST message wins (the assistant reply, not the user question),
    // and the wire carries the run row's updatedAt for the activity label.
    expect(wire?.lastMessage).toBe('the reply');
    expect(wire?.updatedAt).toBe(new Date(0).toISOString());

    const fresh = await service.createChat({ agentKind: 'claude', cwd: dir });
    const relisted = await service.listChats();
    expect(relisted.find((r) => r.id === fresh.id)?.lastMessage).toBeNull();
  });

  it('rename updates the title and returns the enriched wire', async () => {
    const { service, runDao, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(run.id, 'hello');
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();

    const wire = await service.rename(run.id, 'Auth refactor');
    expect(wire.title).toBe('Auth refactor');
    expect(wire.lastMessage).toBe('hello');
    expect((await runDao.getById(run.id))?.title).toBe('Auth refactor');
  });

  it('rename deliberately accepts a WORKFLOW run (run-level, not kind-guarded)', async () => {
    const { service, runDao } = setup();
    const run = await runDao.create({
      workflowId: 'review-team',
      status: 'completed',
    });

    const wire = await service.rename(run.id, 'Nightly review');
    expect(wire.title).toBe('Nightly review');
    expect((await runDao.getById(run.id))?.title).toBe('Nightly review');
  });

  it('rename 404s on an unknown run', async () => {
    const { service } = setup();
    await expect(service.rename('nope', 'x')).rejects.toThrow(
      /RUN_NOT_FOUND|not found/,
    );
  });
});

describe('ChatService — approval modes (parity M1)', () => {
  let dir: string;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'geniro-chat-appr-')));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const QUESTION_INPUT = {
    questions: [
      {
        question: 'Which color?',
        options: [{ label: 'Red' }, { label: 'Blue' }],
      },
    ],
  };

  it("createChat defaults both CLIs to 'ask' and rejects only a cursor plan mode", async () => {
    const { service } = setup();
    const claudeRun = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
    });
    expect(claudeRun.approval).toBe('ask');
    const planRun = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      approval: 'plan',
    });
    expect(planRun.approval).toBe('plan');
    // ACP gives cursor a real permission protocol, so its chats take the same
    // default and honour the same modes claude's do.
    const cursorRun = await service.createChat({
      agentKind: 'cursor-agent',
      cwd: dir,
    });
    expect(cursorRun.approval).toBe('ask');
    const cursorAcceptEdits = await service.createChat({
      agentKind: 'cursor-agent',
      cwd: dir,
      approval: 'acceptEdits',
    });
    expect(cursorAcceptEdits.approval).toBe('acceptEdits');
    // `plan` is the exception: it maps to an agent-declared ACP session mode
    // nothing here can confirm cursor offers.
    await expect(
      service.createChat({
        agentKind: 'cursor-agent',
        cwd: dir,
        approval: 'plan',
      }),
    ).rejects.toThrow("cursor-agent does not support the approval mode 'plan'");
  });

  it('updateSettings flips the mode between turns, refuses on a CLAIMED run, and 400s a cursor plan mode', async () => {
    const { service, registry } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    const updated = await service.updateSettings(run.id, {
      approval: 'acceptEdits',
    });
    expect(updated.approval).toBe('acceptEdits');

    // CLAIMED but not yet spawned: there is no process to be told, and the turn
    // about to start has not read its settings row yet. Refused rather than
    // ACKed — a change that reaches neither the CLI nor the snapshot the turn
    // is about to take is a change that did not happen.
    expect(registry.tryClaim(run.id)).toBe(true);
    await expect(
      service.updateSettings(run.id, { approval: 'auto' }),
    ).rejects.toThrow('cannot be changed until it settles');
    // ...while the cosmetic fields go through on the same claimed run.
    const midTurn = await service.updateSettings(run.id, { model: 'opus' });
    expect(midTurn.model).toBe('opus');
    expect(midTurn.approval).toBe('acceptEdits');
    registry.release(run.id);

    const cursorRun = await service.createChat({
      agentKind: 'cursor-agent',
      cwd: dir,
    });
    await expect(
      service.updateSettings(cursorRun.id, { approval: 'plan' }),
    ).rejects.toThrow("cursor-agent does not support the approval mode 'plan'");
    const flipped = await service.updateSettings(cursorRun.id, {
      approval: 'acceptEdits',
    });
    expect(flipped.approval).toBe('acceptEdits');
  });

  it('hands an approval change to the turn ALREADY RUNNING, not to the next one', async () => {
    // The behaviour the user asked for, in the CLI's own words: a mode switch
    // applies as soon as possible. The CLI accepts `set_permission_mode` on a
    // turn in flight and re-reads it in milliseconds (probe-verified on
    // 2.1.222), so refusing here was this service's limitation, not the
    // agent's.
    const { service, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.updateSettings(run.id, { approval: 'ask' });
    await service.sendMessage(run.id, 'go');

    const updated = await service.updateSettings(run.id, {
      approval: 'acceptEdits',
    });

    expect(claude.handles[0]!.setApprovalMode).toHaveBeenCalledWith(
      'acceptEdits',
    );
    expect(updated.approval).toBe('acceptEdits');
    claude.finish();
    await drain();
  });

  it('moves the DAEMON’s own auto-approve seam with it, not just the CLI', async () => {
    // Two halves have to move together. The CLI decides which tools it even
    // asks about; the daemon decides what to do with the ones it is asked. An
    // `auto` turn switched to `ask` that only told the CLI would keep
    // auto-approving every request the CLI still sent — the user would see the
    // chip read `ask` while the turn approved everything for them.
    const { service, claude, approvals, itemDao } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.updateSettings(run.id, { approval: 'auto' });
    await service.sendMessage(run.id, 'go');

    await service.updateSettings(run.id, { approval: 'ask' });
    claude.emit({
      type: 'approval_request',
      id: 'p-1',
      toolName: 'Bash',
      input: {},
    });
    await drain();

    // Parked for a human instead of auto-approved.
    expect(claude.handles[0]!.respondApproval).not.toHaveBeenCalled();
    expect(approvals.listByRun(run.id)).toHaveLength(1);
    expect(itemDao.items.some((i) => i.kind === 'approval_request')).toBe(true);
    claude.finish();
    await drain();
  });

  it('judges a BETWEEN-turn request by the mode the user last chose, not the last turn’s', async () => {
    // The between-turn policy is built per TURN and closes over that turn's
    // own `approvalMode` variable, so nothing updates it once the turn has
    // settled. Change the chip while no turn is running — the one moment the
    // chip is freely changeable, since a claimed run refuses — and the run row
    // and the chip both read `ask` while the live CLI's between-turn seam is
    // still the `auto` closure turn 1 installed.
    //
    // The direction is the dangerous one: the user asked for a gate and every
    // permission the kept process raises between turns is granted for them,
    // with no card, no transcript row, and nothing said. That is the same
    // silent wrong verdict the whole between-turn change exists to end.
    //
    // Read through the policy the SESSION was opened with, because that is the
    // one the live process calls; asserting on anything else would prove
    // nothing about what the CLI is told.
    const { service, claude } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      approval: 'auto',
    });
    await service.sendMessage(run.id, 'go');
    const policy = claude.sessions[0]?.betweenTurnApproval;
    expect(policy?.({ toolName: 'Bash' })).toBe(true);

    claude.finish();
    await drain();
    const updated = await service.updateSettings(run.id, { approval: 'ask' });
    expect(updated.approval).toBe('ask');

    // `null` is HOLD — the request waits for the next turn to show it as a
    // card. `true` here is a permission granted in the user's name under a
    // posture they have already left.
    expect(policy?.({ toolName: 'Bash' })).toBeNull();
  });

  it('REFUSES when the running turn has no permission gate to be told through', async () => {
    // The one case that is still genuinely unhonourable: a turn spawned under
    // `--dangerously-skip-permissions` has no prompt tool wired, so no message
    // can reintroduce a gate the process was started without. The handle says
    // so, and the refusal must leave the stored mode untouched — ACKing would
    // state a safety posture the user does not have.
    const { service, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.updateSettings(run.id, { approval: 'auto' });
    await service.sendMessage(run.id, 'go');
    claude.handles[0]!.setApprovalMode.mockReturnValue(false);

    await expect(
      service.updateSettings(run.id, { approval: 'ask' }),
    ).rejects.toThrow('cannot be changed until it settles');

    claude.finish();
    await drain();
    const [after] = await service.listChats();
    expect(after?.approval).toBe('auto');
  });

  it('updateSettings changes the model mid-chat — the NEXT turn spawns with it', async () => {
    const { service, claude } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      model: 'sonnet',
    });
    await service.sendMessage(run.id, 'first');
    expect((claude.start.mock.calls[0]![0] as AgentTurnInput).model).toBe(
      'sonnet',
    );
    claude.finish();
    await drain();

    const updated = await service.updateSettings(run.id, { model: 'opus' });
    expect(updated.model).toBe('opus');
    await service.sendMessage(run.id, 'second');
    expect((claude.start.mock.calls[1]![0] as AgentTurnInput).model).toBe(
      'opus',
    );
    claude.finish();
    await drain();
  });

  it('a null model clears the run back to the CLI default — no --model at all', async () => {
    const { service, claude } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      model: 'opus',
    });
    const cleared = await service.updateSettings(run.id, { model: null });
    expect(cleared.model).toBeNull();
    await service.sendMessage(run.id, 'go');
    // undefined, not 'opus': the adapter omits the flag entirely, which is a
    // different run than pinning whatever the previous model was.
    expect(
      (claude.start.mock.calls[0]![0] as AgentTurnInput).model,
    ).toBeUndefined();
    claude.finish();
    await drain();
  });

  it('carries the stored effort onto the turn and clears it back to no flag', async () => {
    const { service, claude } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      effort: 'xhigh',
    });
    expect(run.effort).toBe('xhigh');
    await service.sendMessage(run.id, 'first');
    expect((claude.start.mock.calls[0]![0] as AgentTurnInput).effort).toBe(
      'xhigh',
    );
    claude.finish();
    await drain();

    const cleared = await service.updateSettings(run.id, { effort: null });
    expect(cleared.effort).toBeNull();
    await service.sendMessage(run.id, 'second');
    // undefined, not 'xhigh': null means the CLI's own default, so the adapter
    // must omit `--effort` rather than re-send the previous level.
    expect(
      (claude.start.mock.calls[1]![0] as AgentTurnInput).effort,
    ).toBeUndefined();
    claude.finish();
    await drain();
  });

  it('refuses an effort the run CLI does not list, per CLI', async () => {
    const { service } = setup();
    // 'ultrathink' is the probe-verified REJECTED value: claude warns and runs
    // at its own effort, so accepting it here would ACK a turn setting that
    // never takes effect.
    await expect(
      service.createChat({
        agentKind: 'claude',
        cwd: dir,
        effort: 'ultrathink',
      }),
    ).rejects.toThrow(
      "claude does not accept the reasoning effort 'ultrathink'",
    );

    // cursor-agent is NOT refused up front, and that asymmetry is the rule
    // rather than an oversight: its levels belong to the MODEL, so the config
    // list is a union that cannot be complete — `gpt-5.2` offers `extra-high`,
    // which no other model has. Checking it exhaustively refused that level and
    // the chat could not be created at all, on a value the picker had just
    // shown. What guards this CLI instead is its turn driver, which checks the
    // value against the model that will run it.
    const cursorRun = await service.createChat({
      agentKind: 'cursor-agent',
      cwd: dir,
    });
    expect(
      (await service.updateSettings(cursorRun.id, { effort: 'extra-high' }))
        .effort,
    ).toBe('extra-high');
    // …and a level in its own union goes through too, which is the whole feature.
    expect(
      (await service.updateSettings(cursorRun.id, { effort: 'xhigh' })).effort,
    ).toBe('xhigh');

    // …while a level claude DOES list goes through on the same path.
    const claudeRun = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
    });
    const updated = await service.updateSettings(claudeRun.id, {
      effort: 'ultracode',
    });
    expect(updated.effort).toBe('ultracode');
  });

  it('stops claiming the agent is thinking the moment a tool call lands', async () => {
    // The full path for the reported "Thinking… stays up between tool calls".
    // A model that thinks and then calls a tool with nothing to say first emits
    // no text delta, so `append` never fired and the stretch stayed open for
    // the whole command — measured at 3.5s on one turn, unbounded in general.
    const { service, claude, deltas } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(run.id, 'go');

    claude.emit({ type: 'thinking_progress', tokens: 74 });
    await drain();
    expect(deltas.at(-1)?.thinkingStretch).toBe(1);

    claude.emit({
      type: 'tool_call',
      id: 't1',
      name: 'Bash',
      input: { command: 'sleep 40' },
    });
    await drain();

    expect(deltas.at(-1)?.thinkingStretch).toBeNull();
    expect(deltas.at(-1)?.thinkingTokens).toBeNull();

    claude.finish();
    await drain();
  });

  it('scales the live meter from the FIRST request once a model’s window is known', async () => {
    // End to end for the per-model window: the CLI names its model at session
    // start, the turn's result line reports that model's window, and the NEXT
    // chat on the same model is scaled from its very first request — instead
    // of showing an unscaled count until a turn finished.
    const { service, claude, deltas } = setup();
    const first = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(first.id, 'go');
    claude.emit({ type: 'turn_model', model: 'claude-opus-5[1m]' });
    claude.emit({ type: 'context_progress', contextTokens: 1_000 });
    await drain();
    // Nothing has reported a window yet, so the meter says so rather than
    // inventing one.
    expect(deltas.at(-1)?.contextWindowTokens).toBeNull();
    claude.emit({
      type: 'turn_complete',
      usage: {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        thinkingTokens: null,
        contextTokens: 1_000,
        contextWindowTokens: 1_000_000,
        contextModel: 'claude-opus-5[1m]',
        costUsd: null,
        durationMs: null,
        apiMs: null,
      },
      stopReason: 'end_turn',
      finalText: null,
    });
    claude.finish();
    await drain();

    const second = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(second.id, 'go');
    claude.emit({ type: 'turn_model', model: 'claude-opus-5[1m]' });
    claude.emit({ type: 'context_progress', contextTokens: 26_000 });
    await drain();
    expect(deltas.at(-1)).toMatchObject({
      runId: second.id,
      contextTokens: 26_000,
      contextWindowTokens: 1_000_000,
    });
    claude.finish();
    await drain();
  });

  it('files every live reading on the RUN ROW, mid-turn', async () => {
    // The live plane is ephemeral, so a window that reloads, reconnects, or
    // opens the chat for the first time has only the run row to read — and
    // without this it read the last SETTLED turn instead, which on an hour-long
    // turn is an hour old. REPORTED as a ring at 2% beside a panel at 46%.
    const { service, claude, runDao } = setup();
    const chat = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(chat.id, 'go');

    claude.emit({
      type: 'context_progress',
      contextTokens: 120_000,
      contextWindowTokens: 1_000_000,
    });
    await drain();
    expect(runDao.runs.get(chat.id)).toMatchObject({
      contextTokens: 120_000,
      contextWindowTokens: 1_000_000,
    });

    // …and it keeps up as the same turn grows, which is the whole point: no
    // turn has settled between these two readings.
    claude.emit({ type: 'context_progress', contextTokens: 462_300 });
    await drain();
    expect(runDao.runs.get(chat.id)).toMatchObject({
      contextTokens: 462_300,
      // Unchanged rather than wiped by a reading that named none — a numerator
      // with no denominator is a ring that cannot be drawn.
      contextWindowTokens: 1_000_000,
    });

    claude.finish();
    await drain();
  });

  it('scales the meter from a reading that carries its OWN window', async () => {
    // The reported defect: a cursor chat's readout showed `101.1k of 200k ·
    // 51%` while the ring beside it sat empty. Its figures come from that CLI's
    // own store rather than from the wire, so used and window arrive TOGETHER —
    // and a window that only ever rode `turn_complete` left the ring a
    // numerator with no denominator until the turn was over.
    const { service, claude, deltas } = setup();
    const chat = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(chat.id, 'go');
    claude.emit({
      type: 'context_progress',
      contextTokens: 101_100,
      contextWindowTokens: 200_000,
      contextModel: 'cursor-grok-4.6',
    });
    await drain();

    // Both halves on the SAME delta — not one now and the other after the turn.
    expect(deltas.at(-1)).toMatchObject({
      runId: chat.id,
      contextTokens: 101_100,
      contextWindowTokens: 200_000,
    });

    claude.finish();
    await drain();
  });

  it('a mid-turn model change reaches the NEXT turn and leaves the running one alone', async () => {
    // The whole contract behind the unlocked composer chips. The running turn's
    // argv was fixed when it spawned and nothing can reach it — so the write is
    // accepted, the in-flight turn keeps what it started with, and the change
    // shows up on the turn after it.
    const { service, claude } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      model: 'sonnet',
      effort: 'low',
    });
    await service.sendMessage(run.id, 'first');
    const firstTurn = claude.start.mock.calls[0]![0] as AgentTurnInput;
    expect(firstTurn.model).toBe('sonnet');

    // Mid-turn: the run is claimed and the adapter is streaming.
    const midTurn = await service.updateSettings(run.id, {
      model: 'opus',
      effort: 'max',
    });
    expect(midTurn.model).toBe('opus');
    expect(midTurn.effort).toBe('max');
    // The turn already in flight is untouched — the same object it spawned
    // with, not retro-edited.
    expect(firstTurn.model).toBe('sonnet');
    expect(firstTurn.effort).toBe('low');

    claude.finish();
    await drain();
    await service.sendMessage(run.id, 'second');
    const secondTurn = claude.start.mock.calls[1]![0] as AgentTurnInput;
    expect(secondTurn.model).toBe('opus');
    expect(secondTurn.effort).toBe('max');
    claude.finish();
    await drain();
  });

  it('reverts ONLY the approval half of a write that races a turn claiming the run', async () => {
    // The claim lands between the pre-check and the flush, so the in-flight
    // turn may already be spawning under the old mode. The approval change is
    // refused and rolled back rather than ACKed; the model change stays
    // applied, because it only ever described the next turn and nothing about
    // it is untrue.
    const { service, runDao, registry } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      approval: 'auto',
      model: 'sonnet',
    });
    const originalUpdate = runDao.updateById.bind(runDao);
    let claimedDuringWrite = false;
    runDao.updateById = async (id: string, data: Partial<Run>) => {
      const n = await originalUpdate(id, data);
      if (!claimedDuringWrite) {
        claimedDuringWrite = true;
        registry.tryClaim(id);
      }
      return n;
    };

    await expect(
      service.updateSettings(run.id, { approval: 'ask', model: 'opus' }),
    ).rejects.toThrow('in flight');
    // The race the name promises actually happened — without this the
    // monkeypatch could be deleted and the assertions below would still pass.
    expect(claimedDuringWrite).toBe(true);
    expect(registry.has(run.id)).toBe(true);

    const stored = await runDao.getById(run.id);
    expect(stored?.approval).toBe('auto');
    expect(stored?.model).toBe('opus');
  });

  it('honors a settings flip that committed just before the claim — sendMessage re-reads the committed row after claiming', async () => {
    const { service, claude, runDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      approval: 'auto',
      model: 'sonnet',
    });
    // Gate sendMessage's FIRST run-row read so a full PATCH lands in the
    // window, then release: the snapshotted entity still says 'auto', but the
    // committed row says 'ask'. The post-claim re-read must win.
    const originalGetById = runDao.getById.bind(runDao);
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let gatePending = true;
    runDao.getById = async (id: string): Promise<Run | null> => {
      if (!gatePending) {
        return originalGetById(id);
      }
      gatePending = false;
      const row = await originalGetById(id);
      const snapshot = row ? ({ ...row } as Run) : null;
      await readGate;
      return snapshot;
    };
    const send = service.sendMessage(run.id, 'lock this down');
    await service.updateSettings(run.id, { approval: 'ask', model: 'opus' });
    releaseRead();
    await send;
    const spawned = claude.start.mock.calls[0]![0] as AgentTurnInput;
    expect(spawned.approvalMode).toBe('ask');
    // Both fields come from the same post-claim read — a per-field fallback to
    // the snapshot would spawn the acknowledged mode with the stale model.
    expect(spawned.model).toBe('opus');
    claude.finish();
    await drain();
  });

  it('does not degrade an unsupported plan chat to an executing ask — a no-execute mode rides through, never silently converted', async () => {
    const { service, claude, itemDao } = setup({
      claudeModes: {
        acceptEdits: 'fail',
        plan: 'fail',
        version: 'claude-old',
        probedAt: 0,
        reason: 'x',
      },
    });
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      approval: 'plan',
    });
    await service.sendMessage(run.id, 'draft a plan');
    expect(
      (claude.start.mock.calls[0]![0] as AgentTurnInput).approvalMode,
    ).toBe('plan');
    expect(
      itemDao.items.some(
        (i) => i.kind === 'system' && i.payload.includes("runs as 'ask'"),
      ),
    ).toBe(false);
    claude.finish();
    await drain();
  });

  it('degrades a probe infrastructure failure to unknown and still spawns the turn — a probe error never fails the send', async () => {
    const { service, claude, claudeProbe, runDao } = setup();
    // ensureVerdict rejects (e.g. a probe temp-dir cleanup throw bubbling up).
    (
      claudeProbe as unknown as { ensureVerdict: () => Promise<unknown> }
    ).ensureVerdict = vi.fn(async () => {
      throw new Error('probe cleanup EBUSY');
    });
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      approval: 'acceptEdits',
    });
    await service.sendMessage(run.id, 'go');
    // unknown keeps the requested mode; the turn spawns rather than failing.
    expect(
      (claude.start.mock.calls[0]![0] as AgentTurnInput).approvalMode,
    ).toBe('acceptEdits');
    expect((await runDao.getById(run.id))?.status).not.toBe('failed');
    claude.finish();
    await drain();
  });

  it("sendMessage passes the run row mode to the adapter; a legacy null row runs as 'ask'", async () => {
    const { service, claude, runDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      approval: 'acceptEdits',
    });
    await service.sendMessage(run.id, 'hi');
    expect(
      (claude.start.mock.calls[0]![0] as AgentTurnInput).approvalMode,
    ).toBe('acceptEdits');
    claude.finish();
    await drain();

    // A pre-selector row (approval null) used to pass `undefined`, which
    // spawns the CLI with no permission flag and inherits ITS default. That
    // default moved: probed on claude 2.1.227, a headless turn with no flag
    // reports `permissionMode: "auto"`. So the old behaviour silently turned
    // an unattended-approval posture on for every legacy chat, decided by the
    // vendor. `undefined` here is the regression.
    const legacy = await runDao.create({
      workflowId: null,
      status: 'pending',
      agentKind: 'claude',
      cwd: dir,
      approval: null,
    });
    await service.sendMessage(legacy.id, 'hi');
    expect(
      (claude.start.mock.calls[1]![0] as AgentTurnInput).approvalMode,
    ).toBe('ask');
    claude.finish();
    await drain();
  });

  it("degrades an unsupported acceptEdits turn to 'ask' with a visible system item — never silently", async () => {
    const { service, claude, itemDao } = setup({
      claudeModes: {
        acceptEdits: 'fail',
        plan: 'fail',
        version: 'claude-old',
        probedAt: 0,
        reason:
          'installed claude does not support --permission-mode acceptEdits',
      },
    });
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      approval: 'acceptEdits',
    });
    await service.sendMessage(run.id, 'hi');
    expect(
      (claude.start.mock.calls[0]![0] as AgentTurnInput).approvalMode,
    ).toBe('ask');
    const system = itemDao.items.find(
      (i) =>
        i.kind === 'system' &&
        i.payload.includes('does not support acceptEdits'),
    );
    expect(system).toBeDefined();
    claude.finish();
    await drain();
  });

  it("keeps a plan chat on 'plan' under the SAME failing verdict — one policy, both paths", async () => {
    // The chat mirror of the graph executor's plan test: identical probe
    // verdict, opposite outcome from acceptEdits above. Both paths now read one
    // adapter answer, so a policy change cannot land on one and miss the other
    // — which is exactly the divergence this fold removed.
    const { service, claude, itemDao } = setup({
      claudeModes: {
        acceptEdits: 'fail',
        plan: 'fail',
        version: 'claude-old',
        probedAt: 0,
        reason: 'installed claude rejects both probed modes',
      },
    });
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      approval: 'plan',
    });
    await service.sendMessage(run.id, 'hi');
    expect(
      (claude.start.mock.calls[0]![0] as AgentTurnInput).approvalMode,
    ).toBe('plan');
    expect(
      itemDao.items.some(
        (i) => i.kind === 'system' && i.payload.includes('does not support'),
      ),
    ).toBe(false);
    claude.finish();
    await drain();
  });

  it('does not probe for a mode the CLI never declared empirical', async () => {
    // `config.approval.probedModes` is what keeps an 'auto' chat off the
    // probe path; without it every turn would await a verdict it has no use
    // for.
    const { service, claude, claudeProbe } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      approval: 'auto',
    });
    await service.sendMessage(run.id, 'hi');
    expect(claudeProbe.ensureVerdict).not.toHaveBeenCalled();
    claude.finish();
    await drain();
  });

  it('records ANSWERING a card as activity, so the sidebar stops demoting the thread', async () => {
    // REPORTED as "как только я на него ответил, он переместился обратно. То
    // есть он прыгает!". The sidebar floats a thread that is asking something
    // to the top and orders everything else by `updatedAt` — and answering
    // wrote no status, so the row still carried the time its TURN began. On the
    // reporter's own database `CI336` was stamped 15:44:21, with three threads
    // written since, so one click sent it from first place to fourth.
    const { service, claude, approvals, runDao, statuses } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(run.id, 'hi');
    claude.emit({
      type: 'approval_request',
      id: 'q-1',
      toolName: 'AskUserQuestion',
      input: QUESTION_INPUT,
      requiresUserInteraction: true,
    });
    await drain();
    const before = (await runDao.getById(run.id))!.updatedAt.getTime();

    expect(approvals.resolve(run.id, 'q-1', true, 'Blue')).toBe(true);
    await drain();

    expect(
      (await runDao.getById(run.id))!.updatedAt.getTime(),
    ).toBeGreaterThanOrEqual(before);
    // …and every client is told, since the sort reads their copy of the row.
    const announced = statuses.filter((event) => event.at !== undefined);
    expect(announced.length).toBeGreaterThan(0);
    // It says WHEN, never what the run is doing: the turn was running before
    // the answer and is running after it.
    expect(announced.at(-1)?.status).toBeNull();
    claude.finish();
    await drain();
  });

  it('tracks a chat approval card, folds the answer into AskUserQuestion, and persists the verdict item', async () => {
    const { service, claude, approvals, itemDao } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(run.id, 'hi');
    claude.emit({
      type: 'approval_request',
      id: 'q-1',
      toolName: 'AskUserQuestion',
      input: QUESTION_INPUT,
      requiresUserInteraction: true,
    });
    await drain();
    expect(itemDao.items.some((i) => i.kind === 'approval_request')).toBe(true);
    expect(approvals.listByRun(run.id)).toHaveLength(1);

    const applied = approvals.resolve(run.id, 'q-1', true, 'Blue');
    expect(applied).toBe(true);
    expect(claude.handles[0]!.respondApproval).toHaveBeenCalledWith(
      'q-1',
      true,
      {
        ...QUESTION_INPUT,
        answers: { 'Which color?': 'Blue' },
      },
    );
    await drain();
    const verdict = itemDao.items.find((i) => i.kind === 'approval_verdict');
    expect(verdict).toBeDefined();
    expect(JSON.parse(verdict!.payload)).toMatchObject({
      id: 'q-1',
      allow: true,
      answer: 'Blue',
    });
    claude.finish();
    await drain();
    expect(approvals.listByRun(run.id)).toEqual([]);
  });

  it('draws the card for a question that arrives with NO turn in flight, and routes the verdict to the live process', async () => {
    // The incident this was written from, reconstructed off the user's own
    // database and daemon log: claude's process outlived its turn, asked an
    // `AskUserQuestion` eight minutes later, and the request was HELD for a
    // turn that never came. The transcript grew the tool-call row and the badge
    // read "working", so for twenty-two minutes the app showed progress while
    // the CLI stood blocked on a person with no control to answer with — and
    // then the idle window closed the process, which the CLI read as a refusal.
    // The user was left with a bare "claude run failed".
    const { service, claude, approvals, itemDao } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(run.id, 'hi');
    claude.finish();
    await drain();

    // Only a run-scoped process can reach this seam: the turn is over, so
    // there is no handle and no `onEvent` left to raise a card through.
    const respond = vi.fn(() => true);
    const raised = claude.sessions[0]!.onHeldApproval!(
      {
        type: 'approval_request',
        id: 'q-off',
        toolName: 'AskUserQuestion',
        input: QUESTION_INPUT,
        requiresUserInteraction: true,
      },
      respond,
    );
    expect(raised).toBe(true);
    await drain();

    // A real card: a replayable row AND a live entry a verdict can reach.
    expect(itemDao.items.some((i) => i.kind === 'approval_request')).toBe(true);
    expect(approvals.listByRun(run.id)).toHaveLength(1);

    expect(approvals.resolve(run.id, 'q-off', true, 'Blue')).toBe(true);
    // Answered through the SESSION, not a turn — there is none to answer
    // through — with the question's own input folded, so the agent receives a
    // pick rather than a blanked argument list.
    expect(respond).toHaveBeenCalledWith(true, {
      ...QUESTION_INPUT,
      answers: { 'Which color?': 'Blue' },
    });
    await drain();
    const verdict = itemDao.items.find((i) => i.kind === 'approval_verdict');
    expect(JSON.parse(verdict!.payload)).toMatchObject({
      id: 'q-off',
      allow: true,
      answer: 'Blue',
    });
  });

  it('announces what the run just SAID, mid-turn, on the client-wide channel', async () => {
    // Items reach ONE room and a client joins one at a time, so a thread
    // working in the background delivers none of them to the window watching
    // the sidebar. REPORTED as "still i see here outdated last llm message. As
    // soon as i click on thread - it will be updated to actual one", against a
    // thread that was still RUNNING — the settle-time fix moves the line when a
    // turn ends, which is minutes too late on a long one.
    const { service, claude, statuses } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(run.id, 'hi');
    await drain();
    statuses.length = 0;

    claude.emit({ type: 'text', text: 'halfway there' });
    await drain();

    // No status and no activity key: this announce read neither, and a null
    // activity would blank the phrase of a turn that is still working.
    expect(statuses).toContainEqual({
      runId: run.id,
      status: null,
      preview: 'halfway there',
    });
    // And NOT as `summary`, which is terminal-only and is what the system
    // notification reads — a mid-turn sentence there would have a banner
    // announce half a turn.
    expect(statuses.some((event) => event.summary !== undefined)).toBe(false);

    claude.finish();
    await drain();
  });

  it('announces the USER’s own message too, because the row’s line is whatever spoke last', async () => {
    // `lastMessage` is the run's latest `message` row whatever wrote it, and
    // the list endpoints enrich it that way — announcing only the agent's would
    // make the live line disagree with the value the next refetch puts back.
    const { service, statuses } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    statuses.length = 0;

    await service.sendMessage(run.id, 'my question');
    await drain();

    expect(statuses).toContainEqual({
      runId: run.id,
      status: null,
      preview: 'my question',
    });
  });

  it('announces the run as parked on the user while a question is open, and unparked once it is answered', async () => {
    // The badge half of a parked turn, and the reason it is on the STATUS
    // channel rather than derived from items: items only reach the room of the
    // run in focus, so a chat sitting on an unanswered question showed a
    // spinner in the sidebar for as long as the user was looking elsewhere.
    // Revert the two announces and the `awaiting` key disappears from both
    // assertions below.
    const { service, claude, statuses, approvals } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(run.id, 'hi');
    await drain();
    claude.emit({
      type: 'approval_request',
      id: 'q-1',
      toolName: 'AskUserQuestion',
      input: QUESTION_INPUT,
      requiresUserInteraction: true,
    });
    await drain();

    // The KIND, and no phrase: the daemon owns the fact, the renderer words it
    // (`awaitingPhrase`). Sending the sentence here made it live-only — the
    // activity plane is events, so a reloaded window had a correct badge with
    // nothing under it.
    expect(statuses).toContainEqual({
      runId: run.id,
      status: null,
      activity: null,
      awaiting: 'question',
    });

    statuses.length = 0;
    // Through the registry, exactly as the WS verdict does.
    expect(approvals.resolve(run.id, 'q-1', true, 'Blue')).toBe(true);
    await drain();
    // Cleared, and cleared as null rather than by omission: absent would leave
    // the client's reading exactly as it was — still parked.
    expect(statuses).toContainEqual({
      runId: run.id,
      status: null,
      activity: null,
      awaiting: null,
    });
    claude.finish();
    await drain();
  });

  it('serves the parked reading on the run row too, so a reloaded window learns it', async () => {
    // The snapshot half. A parked run emits nothing further by definition, so a
    // window that connects AFTER the transition has only the row to read it
    // off; without this it shows a spinner until the user clicks in.
    const { service, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(run.id, 'hi');
    await drain();
    expect(
      (await service.listChats()).find((r) => r.id === run.id)?.awaiting,
    ).toBeNull();

    claude.emit({
      type: 'approval_request',
      id: 'q-1',
      toolName: 'AskUserQuestion',
      input: QUESTION_INPUT,
      requiresUserInteraction: true,
    });
    await drain();

    expect(
      (await service.listChats()).find((r) => r.id === run.id)?.awaiting,
    ).toBe('question');

    // …and a settled turn is parked on nothing, whatever it was holding: the
    // sweep drops the card, so the badge must not go on blaming the user.
    claude.finish();
    await drain();
    expect(
      (await service.listChats()).find((r) => r.id === run.id)?.awaiting,
    ).toBeNull();
  });

  it('records every approval still pending when the turn settles as unanswerable — and none when they were answered', async () => {
    // The run-level half of the expiry the renderer used to infer: a chat turn
    // that ends leaves cards on screen whose buttons answer into nothing. The
    // daemon names each dead request instead, so the UI needs no inference.
    const { service, claude, itemDao, approvals } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(run.id, 'hi');
    claude.emit({
      type: 'approval_request',
      id: 'req-a',
      toolName: 'Bash',
      input: { command: 'ls' },
    });
    claude.emit({
      type: 'approval_request',
      id: 'req-b',
      toolName: 'Write',
      input: { path: 'x' },
    });
    await drain();
    expect(approvals.listByRun(run.id)).toHaveLength(2);

    // One gets an answer; only the OTHER can be unanswerable.
    expect(approvals.resolve(run.id, 'req-a', true)).toBe(true);
    await drain();

    claude.finish();
    await drain();
    const dead = itemDao.items.filter((i) => i.kind === 'unanswerable');
    expect(dead.map((i) => JSON.parse(i.payload))).toEqual([
      { id: 'req-b', toolName: 'Write' },
    ]);
  });

  it('streams assistant text live WITHOUT writing a row per delta', async () => {
    const { service, claude, itemDao, deltas } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(run.id, 'hi');
    const before = itemDao.items.length;

    claude.emit({ type: 'text_delta', text: 'The ' });
    claude.emit({ type: 'text_delta', text: 'sea ' });
    claude.emit({ type: 'text_delta', text: 'is wide.' });
    await drain();

    // Each delta publishes the WHOLE tail (replace semantics), so a client
    // that missed one is correct again on the next.
    expect(deltas.map((d) => d.text)).toEqual([
      'The ',
      'The sea ',
      'The sea is wide.',
    ]);
    // …and not one of them became a durable row.
    expect(itemDao.items.length).toBe(before);
  });

  it('retires the live text the moment the durable message lands', async () => {
    const { service, claude, itemDao, deltas } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(run.id, 'hi');

    claude.emit({ type: 'text_delta', text: 'The sea' });
    claude.emit({ type: 'text', text: 'The sea is wide.' });
    await drain();

    // An empty tail is the signal to stop rendering the live copy — without
    // it the same words would show twice, live and durable.
    expect(deltas.at(-1)).toMatchObject({ text: '' });
    const messages = itemDao.items.filter((i) => i.kind === 'message');
    expect(JSON.parse(messages.at(-1)!.payload)).toEqual({
      text: 'The sea is wide.',
    });
  });

  it('flushes ONE partial-flagged message when a turn dies mid-block', async () => {
    // The user watched these words appear; an afterSeq replay must show the
    // same transcript rather than losing them.
    const { service, claude, itemDao } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(run.id, 'hi');

    claude.emit({ type: 'text_delta', text: 'half a thou' });
    claude.emit({ type: 'turn_cancelled' });
    claude.finish();
    await drain();

    const partials = itemDao.items
      .filter((i) => i.kind === 'message')
      .map((i) => JSON.parse(i.payload) as Record<string, unknown>)
      .filter((p) => p.partial === true);
    expect(partials).toEqual([{ text: 'half a thou', partial: true }]);
  });

  it('flushes nothing when every streamed word already became durable', async () => {
    // The common case: a clean turn must not append a duplicate partial row.
    const { service, claude, itemDao } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(run.id, 'hi');

    claude.emit({ type: 'text_delta', text: 'all of it' });
    claude.emit({ type: 'text', text: 'all of it' });
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: 'all of it',
    });
    claude.finish();
    await drain();

    const messages = itemDao.items
      .filter((i) => i.kind === 'message')
      .map((i) => JSON.parse(i.payload) as Record<string, unknown>);
    expect(messages.filter((p) => p.partial === true)).toEqual([]);
    expect(messages.filter((p) => p.text === 'all of it')).toHaveLength(1);
  });

  it('asks the ADAPTER whether the turn can stream, never the agent kind', async () => {
    const { service, claude, cursor } = setup();
    const claudeRun = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
    });
    await service.sendMessage(claudeRun.id, 'hi');
    const cursorRun = await service.createChat({
      agentKind: 'cursor-agent',
      cwd: dir,
    });
    await service.sendMessage(cursorRun.id, 'hi');

    expect(
      (claude.start.mock.calls[0]![0] as AgentTurnInput).streamPartials,
    ).toBe(true);
    // cursor-agent reports no partial-output mode, so its turn is unchanged.
    expect(
      (cursor.start.mock.calls[0]![0] as AgentTurnInput).streamPartials,
    ).toBe(false);
  });

  it('lets an AUTO chat ask the user a real question instead of writing prose', async () => {
    // The screenshot bug: auto-approve mapped to --dangerously-skip-permissions,
    // which strips AskUserQuestion, so the agent enumerated its options as text.
    const { service, claude, approvals, itemDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      approval: 'auto',
    });
    await service.sendMessage(run.id, 'hi');

    // The turn must be spawned able to ask at all.
    const input = claude.start.mock.calls[0]![0] as AgentTurnInput;
    expect(input.allowUserQuestions).toBe(true);

    claude.emit({
      type: 'approval_request',
      id: 'q-1',
      toolName: 'AskUserQuestion',
      input: QUESTION_INPUT,
      requiresUserInteraction: true,
    });
    await drain();

    expect(itemDao.items.some((i) => i.kind === 'approval_request')).toBe(true);
    expect(approvals.listByRun(run.id)).toHaveLength(1);
    // The question is NOT auto-approved away — it waits for the human.
    expect(claude.handles[0]!.respondApproval).not.toHaveBeenCalled();
  });

  it('keeps an AUTO chat unattended for ordinary tool permissions', async () => {
    // Spawning on the stdio dialogue must not turn auto-approve into a chat
    // that prompts: the daemon becomes the bypass for everything that is not
    // a question, silently and with no transcript row.
    const { service, claude, approvals, itemDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      approval: 'auto',
    });
    await service.sendMessage(run.id, 'hi');
    claude.emit({
      type: 'approval_request',
      id: 'p-1',
      toolName: 'Bash',
      input: { command: 'ls' },
    });
    await drain();

    expect(claude.handles[0]!.respondApproval).toHaveBeenCalledWith(
      'p-1',
      true,
      {
        command: 'ls',
      },
    );
    expect(itemDao.items.some((i) => i.kind === 'approval_request')).toBe(
      false,
    );
    expect(approvals.listByRun(run.id)).toEqual([]);
  });

  it('auto-approves a findings report on an ASK chat, under claude’s own spelling', async () => {
    // The NAME is the load-bearing half, and the counterweight is the ASK-mode
    // test directly below: claude spells an MCP tool `mcp__<server>__<tool>`,
    // so the request never arrives as the bare tool name. `ask` is the default
    // posture, so a predicate that missed this spelling would cost a permission
    // card before every single report.
    const { service, claude, approvals, itemDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      approval: 'ask',
    });
    await service.sendMessage(run.id, 'hi');
    claude.emit({
      type: 'approval_request',
      id: 'p-findings',
      toolName: `mcp__${hostMcpServerName(run.id)}__report_findings`,
      input: { findings: [] },
    });
    await drain();

    expect(claude.handles[0]!.respondApproval).toHaveBeenCalledWith(
      'p-findings',
      true,
      { findings: [] },
    );
    expect(itemDao.items.some((i) => i.kind === 'approval_request')).toBe(
      false,
    );
    expect(approvals.listByRun(run.id)).toEqual([]);
  });

  it('still shows the card for every permission in ASK mode', async () => {
    // The auto-approve branch must be reachable ONLY from auto — an ask chat
    // keeps the human gate on ordinary tools.
    const { service, claude, approvals, itemDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      approval: 'ask',
    });
    await service.sendMessage(run.id, 'hi');
    claude.emit({
      type: 'approval_request',
      id: 'p-2',
      toolName: 'Bash',
      input: { command: 'ls' },
    });
    await drain();

    expect(itemDao.items.some((i) => i.kind === 'approval_request')).toBe(true);
    expect(approvals.listByRun(run.id)).toHaveLength(1);
    expect(claude.handles[0]!.respondApproval).not.toHaveBeenCalled();
  });

  it("never both ACKs a flip to 'ask' and spawns the racing turn as 'auto' — a settings PATCH landing during sendMessage's run-row read must not be ignored", async () => {
    const { service, claude, runDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      approval: 'auto',
    });

    // Model the production read semantics: sendMessage hydrates the run row in
    // its OWN EntityManager fork (BaseDao.updateById loads + flushes in the
    // PATCH handler's separate fork), so a write that lands after the SELECT
    // executed does NOT mutate the already-hydrated entity. The first getById
    // (sendMessage's) therefore snapshots the row at query time and only then
    // parks on the gate — exactly a slow read racing a fast concurrent PATCH.
    const originalGetById = runDao.getById.bind(runDao);
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let gatePending = true;
    runDao.getById = async (id: string): Promise<Run | null> => {
      if (!gatePending) {
        return originalGetById(id);
      }
      gatePending = false;
      const row = await originalGetById(id);
      const snapshot = row ? ({ ...row } as Run) : null;
      await readGate;
      return snapshot;
    };

    // The send hits the gated read first (synchronously, before any claim).
    const send = service.sendMessage(run.id, 'lock this chat down');

    // The flip completes — no claim exists yet, so nothing 409s it. Record
    // whether the daemon ACKed it; a refusal would be an honest outcome too.
    let ackedApproval: string | null = null;
    await service
      .updateSettings(run.id, { approval: 'ask' })
      .then((wire) => {
        ackedApproval = wire.approval;
      })
      .catch(() => {
        // Refused (e.g. RUN_BUSY) — acceptable: refusal is not a silent drop.
      });

    releaseRead();
    await send;
    expect(claude.start).toHaveBeenCalledTimes(1);
    const spawnedApprovalMode = (
      claude.start.mock.calls[0]![0] as AgentTurnInput
    ).approvalMode;
    // The invariant under attack: the daemon must never acknowledge 'ask' to
    // the user AND still spawn the concurrent turn under the stale 'auto'
    // (which maps to --dangerously-skip-permissions on the CLI). Either the
    // PATCH is refused (ackedApproval stays null; the stale 'auto' spawn is
    // then correct), or the spawned turn honors the acknowledged mode.
    expect({ ackedApproval, spawnedApprovalMode }).toEqual(
      ackedApproval === null
        ? { ackedApproval: null, spawnedApprovalMode: 'auto' }
        : { ackedApproval: 'ask', spawnedApprovalMode: 'ask' },
    );
    claude.finish();
    await drain();
  });

  it('sweeps pending chat approvals on settle — including the persistence-failure early-return path', async () => {
    const { service, claude, approvals, runDao, itemDao } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    await service.sendMessage(run.id, 'hi');
    claude.emit({
      type: 'approval_request',
      id: 'p-1',
      toolName: 'Bash',
      input: { command: 'ls' },
    });
    await drain();
    expect(approvals.listByRun(run.id)).toHaveLength(1);

    // Trip the event-persistence failure so the finalizer takes its early
    // return — the sweep must fire on that path too.
    itemDao.failNextKind = 'turn_complete';
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: 'end_turn',
      finalText: null,
    });
    claude.finish();
    await drain();
    expect((await runDao.getById(run.id))?.status).toBe('failed');
    expect(approvals.listByRun(run.id)).toEqual([]);
  });
});

describe('ChatService — delete is a one-way door', () => {
  /** A chat with one persisted item, ready to delete. */
  async function chatWithHistory() {
    const ctx = setup();
    const run = await ctx.service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await ctx.itemDao.create({
      runId: run.id,
      seq: 0,
      kind: 'message',
      payload: JSON.stringify({ text: 'hi' }),
    });
    return { ...ctx, run };
  }

  it('removes the run, its items and its node state', async () => {
    const { service, run, runDao, itemDao, nodeDao } = await chatWithHistory();
    expect(itemDao.items).toHaveLength(1);

    expect(await service.delete(run.id)).toEqual({ deleted: true });

    expect(await runDao.getById(run.id)).toBeNull();
    expect(itemDao.items).toHaveLength(0);
    // All three tables, not just the one the run row lives in: nothing
    // cascades — `Item.runId` is a plain string column with no FK.
    expect(nodeDao.hardDeleted).toEqual([{ runId: run.id }]);
  });

  it('deletes with the soft-delete filter DISABLED', async () => {
    // Spied rather than driven through a pre-soft-deleted row: nothing in the
    // daemon writes `deletedAt`, so such a row is unreachable and a test that
    // manufactured one would pin an invented state instead of this call.
    const { service, run, runDao, itemDao, nodeDao } = await chatWithHistory();
    await service.delete(run.id);

    // The filter-disabling variant, never the plain `hardDelete` that hydrates
    // through `deletedAt: null` and would silently skip a soft-deleted row.
    expect(runDao.hardDeleted).toEqual([{ id: run.id }]);
    expect(itemDao.hardDeleted).toEqual([{ runId: run.id }]);
    expect(nodeDao.hardDeleted).toEqual([{ runId: run.id }]);
  });

  it('removes the run’s attachments directory', async () => {
    const { service, run, removedAttachmentRuns } = await chatWithHistory();
    await service.delete(run.id);
    // Files on disk cascade from nothing at all — only an explicit removal
    // takes them, and the store is the one place that knows the layout.
    expect(removedAttachmentRuns).toEqual([run.id]);
  });

  it('revokes the run’s call tokens', async () => {
    const { service, run, callTokens } = await chatWithHistory();
    callTokens.issue(run.id, 'orch', 'secret-token');
    expect(callTokens.get(run.id, 'orch')).toBe('secret-token');

    await service.delete(run.id);
    expect(callTokens.get(run.id, 'orch')).toBeNull();
  });

  it('announces the deletion so per-run state above this module can be dropped', async () => {
    // Holders of per-run state live in modules ABOVE this one, so they learn
    // by subscription. Without the announcement each would keep state keyed to
    // a run that no longer exists, invisible and unreachable.
    const { service, run, deletedRuns } = await chatWithHistory();
    await service.delete(run.id);
    expect(deletedRuns).toEqual([run.id]);
  });

  it('stops a live turn BEFORE deleting the rows it is still writing', async () => {
    const { service, claude, registry, itemDao, runDao } =
      await chatWithHistory();
    const run = [...runDao.runs.values()][0]!;
    await service.sendMessage(run.id, 'go');
    await drain();
    expect(registry.has(run.id)).toBe(true);

    await service.delete(run.id);
    // The CANCEL itself, not merely the handle's existence: asserting the
    // handle is defined passes with `registry.cancel(runId)` deleted outright,
    // which is the whole behaviour this test is named for.
    expect(claude.handles[0]!.cancel).toHaveBeenCalled();
    expect(registry.has(run.id)).toBe(false);
    expect(itemDao.items).toHaveLength(0);
  });

  it('waits for a cancelled turn to FINALIZE before destroying its rows', async () => {
    // Cancelling only SIGNALS the child. The turn's finalizer then drains the
    // persist queue and writes its terminal rows — so a delete that merely
    // cancels and proceeds leaves items for a run whose `runs` row is gone,
    // unreachable forever because nothing can ever query them again.
    //
    // `delete` therefore awaits the FINALIZER, not `handle.done`: the finalizer
    // is a continuation on that same promise, so awaiting the handle would
    // resume while the finalizer is still suspended at its own first await.
    const { service, claude, itemDao, runDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    expect(claude.handles[0]).toBeDefined();

    await service.delete(run.id);

    // By the time delete resolves the turn has fully finalized (the fake's
    // cancel settles `done`, as a real handle's does) and wrote nothing.
    expect(itemDao.items).toEqual([]);
    expect(await runDao.getById(run.id)).toBeNull();

    // Nothing arrives afterwards either.
    await drain();
    expect(itemDao.items).toEqual([]);
  });

  it('a turn still crossing the claim→register window aborts instead of outliving the delete', async () => {
    // `finalizing` only covers a turn that reached adapter.start(). Between
    // tryClaim and register the turn is claimed but has no finalizer, and that
    // window contains real awaits (the approval probe, the live-stream check).
    // A delete landing there waits on NOTHING — so the turn must notice the
    // delete itself, or it registers afterwards and writes a whole turn's rows
    // for a run that no longer exists.
    const { service, claude, itemDao, runDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    const release = claude.stallBeforeSpawn();
    const sending = service.sendMessage(run.id, 'go');
    await drain();
    // The turn is claimed but not yet spawned.
    expect(claude.start).not.toHaveBeenCalled();

    const deleted = service.delete(run.id);
    await drain();
    release();
    await expect(sending).rejects.toThrow(
      /deleted while the turn was starting/,
    );
    await deleted;

    // Never spawned, and nothing survives the delete.
    expect(claude.start).not.toHaveBeenCalled();
    expect(itemDao.items).toEqual([]);
    expect(await runDao.getById(run.id)).toBeNull();
  });

  it('a turn resuming while a delete is IN FLIGHT aborts — the row is still there', async () => {
    // The other arm of the same guard. Here the delete has cancelled the turn
    // and passed its own checks but has NOT yet purged the rows, so re-reading
    // the run finds it alive; only the `deleting` Set knows the run is doomed.
    // Without that arm the turn spawns and its finalizer writes rows the purge
    // then orphans.
    const { service, claude, runDao, itemDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    const releaseSpawn = claude.stallBeforeSpawn();
    const sending = service.sendMessage(run.id, 'go');
    await drain();

    let releasePurge = (): void => {};
    runDao.purgeGate = new Promise<void>((resolve) => {
      releasePurge = resolve;
    });
    const deleted = service.delete(run.id);
    await drain();
    // Mid-delete: the row still exists, so only the Set can catch this.
    expect(await runDao.getById(run.id)).not.toBeNull();

    releaseSpawn();
    await expect(sending).rejects.toThrow(
      /deleted while the turn was starting/,
    );
    releasePurge();
    await deleted;

    expect(claude.start).not.toHaveBeenCalled();
    expect(itemDao.items).toEqual([]);
    expect(await runDao.getById(run.id)).toBeNull();
  });

  it('refuses to delete a WORKFLOW run through the chat route', async () => {
    // The graph executor owns its own teardown; deleting through here would
    // skip it.
    const { service, runDao } = setup();
    const workflowRun = await runDao.create({
      workflowId: 'wf-1',
      status: 'completed',
    });
    await expect(service.delete(workflowRun.id)).rejects.toThrow();
    expect(await runDao.getById(workflowRun.id)).not.toBeNull();
  });

  it('404s on a run that does not exist', async () => {
    const { service } = setup();
    await expect(service.delete('nope')).rejects.toThrow();
  });
});

describe('ChatService — run status is the truth, and it is broadcast', () => {
  it('reconciles a run whose status LIES when cancel finds no live turn', async () => {
    // The reported defect: a row still saying `running` with no turn left to
    // settle it (a daemon killed mid-turn) stayed "running" forever, and its
    // badge lied in every list that showed it. Cancel is the user saying it is
    // over — before, cancel wrote nothing at all.
    const { service, runDao, itemDao } = setup();
    const run = await runDao.create({ status: 'running', workflowId: null });

    expect(await service.cancel(run.id)).toEqual({ cancelled: false });

    expect((await runDao.getById(run.id))?.status).toBe('cancelled');
    // …and the transcript gets its terminal item, so it does not dangle.
    expect(itemDao.items.map((i) => i.kind)).toContain('turn_cancelled');
  });

  it('persists BOTH halves of a tool call that arrives after its turn settled', async () => {
    // A run-scoped CLI keeps talking after a turn ends — most visibly after a
    // Stop. Only the RESULT half used to be persisted, on the argument that it
    // "lands on a row already on the transcript". That is false when the CALL
    // arrived between turns too and was dropped by the same filter: the
    // renderer then has a result with no call to pair it with, and draws it as
    // its own top-level row. That is what a user reported as strange messages
    // appearing after a cancel — a bare RESULT block holding raw tool output.
    const { service, claude, itemDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    const emit = claude.sessions[0]?.onBetweenTurnEvent;
    expect(emit).toBeTypeOf('function');
    emit?.({ type: 'tool_call', id: 'call-1', name: 'WebSearch', input: {} });
    emit?.({
      type: 'tool_result',
      id: 'call-1',
      name: 'WebSearch',
      result: 'searched',
      isError: false,
    });
    await drain();

    // ORDER and the shared id, not merely presence: `transcript-groups` pairs
    // in one forward pass keyed on the call id, so a result persisted ahead of
    // its call is still an orphan row. An order-blind assertion here would go
    // green on the very bug this test exists for.
    const pair = itemDao.items.filter(
      (i) => i.kind === 'tool_call' || i.kind === 'tool_result',
    );
    expect(pair.map((i) => i.kind)).toEqual(['tool_call', 'tool_result']);
    expect(
      pair.map((i) => (JSON.parse(i.payload) as { id?: string }).id),
    ).toEqual(['call-1', 'call-1']);
  });

  it('keeps an assistant message the CLI wrote after the turn settled', async () => {
    // This REPLACES a test that pinned the opposite ("still drops a
    // between-turn event that has nothing to anchor it"), and the reversal is
    // measured rather than preferred. On a live delegating chat the CLI ran a
    // whole further turn seven seconds after its result line, and the filter
    // that kept only tool rows dropped 2 `text` events, 5 `text_delta`, 2
    // `turn_complete` and a `session` with them — which is the reported "after
    // those jobs finished all messages starting to send incorrectly". The old
    // safety argument was about REPLAYING an event into a later turn; this
    // files it under the run as it arrives, which needs no anchor.
    const { service, claude, itemDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    const before = itemDao.items.length;

    claude.sessions[0]?.onBetweenTurnEvent?.({
      type: 'text',
      text: 'the delegate reported back, so here is what I did with it',
    });
    await drain();

    expect(itemDao.items).toHaveLength(before + 1);
    expect(itemDao.items.at(-1)?.kind).toBe('message');
    expect(itemDao.items.at(-1)?.payload).toContain('the delegate reported');
  });

  it('puts the badge back to running while the CLI carries on by itself', async () => {
    // "it showed complete status, but in fact its not" — the run had settled
    // and the CLI went on working under it. A row arriving off-turn IS the
    // evidence that it is working again.
    const { service, claude, runDao, statuses } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();
    expect((await runDao.getById(run.id))?.status).toBe('completed');
    statuses.length = 0;

    claude.sessions[0]?.onBetweenTurnEvent?.({
      type: 'tool_call',
      id: 'call-9',
      name: 'Bash',
      input: {},
    });
    await drain();

    expect((await runDao.getById(run.id))?.status).toBe('running');
    // …and it says WHOSE running this is, so a chat the user thought was
    // finished does not silently start spinning again with no explanation.
    expect(statuses.at(-1)?.activity).toContain('still working');
  });

  it('puts the badge back to running for a delegate launched between turns', async () => {
    // "it says it's waiting on agent A and B, even though its status is done, complete" —
    // the CLI launched three agents while no turn of ours was open, and the run
    // went on reading `completed` under them. The launch announcement is the
    // evidence that it is working again.
    const { service, claude, runDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();
    expect((await runDao.getById(run.id))?.status).toBe('completed');

    claude.sessions[0]?.onBetweenTurnEvent?.({
      type: 'subagent_info',
      id: 'toolu_a',
      label: null,
      kind: null,
      prompt: null,
      model: null,
      durationMs: null,
      tokens: null,
      toolUses: null,
      stepsUnavailableReason: null,
      backgroundOpen: true,
      backgroundOutcome: null,
    });
    await drain();

    expect((await runDao.getById(run.id))?.status).toBe('running');
  });

  it('does not restart the badge when a delegate merely FINISHES off-turn', async () => {
    // The other direction of the same announcement, and it must not read as the
    // run working: nothing would ever take that spinner down, since a delegate
    // winding up opens no turn of its own to produce a terminal event. The ROW
    // is still written — it is what closes the delegate's block.
    const { service, claude, runDao, itemDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();
    const before = itemDao.items.length;

    claude.sessions[0]?.onBetweenTurnEvent?.({
      type: 'subagent_info',
      id: 'toolu_a',
      label: null,
      kind: null,
      prompt: null,
      model: null,
      durationMs: null,
      tokens: null,
      toolUses: null,
      stepsUnavailableReason: null,
      backgroundOpen: false,
      backgroundOutcome: null,
    });
    await drain();

    expect((await runDao.getById(run.id))?.status).toBe('completed');
    expect(itemDao.items).toHaveLength(before + 1);
    expect(itemDao.items.at(-1)?.kind).toBe('subagent_info');
  });

  it('puts the badge back to running while a DELEGATE goes on producing rows', async () => {
    // "some internal processes are running, but it's shown as
    // Completed" — a delegate whose launching `Task` call already returned has
    // nothing holding the turn open for it, so the result line settles the run
    // while its steps keep arriving. Reproduced against the real renderer: two
    // sub-agent blocks climbing to 7 tool calls under a `✓ completed` header.
    const { service, claude, runDao, statuses } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();
    expect((await runDao.getById(run.id))?.status).toBe('completed');
    statuses.length = 0;

    claude.sessions[0]?.onBetweenTurnEvent?.({
      type: 'tool_call',
      id: 'call-9',
      name: 'Read',
      input: {},
      parentToolUseId: 'toolu_task_1',
    });
    await drain();

    expect((await runDao.getById(run.id))?.status).toBe('running');
    expect(statuses.at(-1)?.activity).toContain('still working');
  });

  it('renews a delegate lease without writing the status again', async () => {
    // A working delegate emits rows continuously, and re-arming an expiry must
    // not cost a write per row — the same short-circuit the thinking path has.
    const { service, claude, runDao, statuses } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();
    statuses.length = 0;

    const emit = claude.sessions[0]?.onBetweenTurnEvent;
    for (let step = 0; step < 6; step += 1) {
      emit?.({
        type: 'tool_call',
        id: `call-${step}`,
        name: 'Read',
        input: {},
        parentToolUseId: 'toolu_task_1',
      });
    }
    await drain();

    expect((await runDao.getById(run.id))?.status).toBe('running');
    expect(statuses.filter((entry) => entry.status === 'running')).toHaveLength(
      1,
    );
  });

  it('keeps the badge while a delegate RENEWS its lease past the first window', async () => {
    // `DELEGATE_ROW_LEASE_MS`'s whole contract is that the claim expires unless
    // the delegate renews it by producing another row. Without the renewal the
    // first row's timer fires on schedule however long the delegate works, so
    // the badge drops back to `completed` under sub-agent blocks still filling
    // — the defect the lease exists to remove.
    //
    // The neighbouring "renews … without writing the status again" test cannot
    // see this: with the renewal deleted, a second row falls through to the
    // `run.status === 'running'` guard and the single write it counts is
    // preserved by that guard instead.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { service, claude, runDao } = setup();
      const run = await service.createChat({
        agentKind: 'claude',
        cwd: process.cwd(),
      });
      await service.sendMessage(run.id, 'go');
      await drain();
      claude.emit({
        type: 'turn_complete',
        usage: null,
        stopReason: null,
        finalText: null,
      });
      claude.finish();
      await drain();

      const emit = claude.sessions[0]?.onBetweenTurnEvent;
      const delegateRow = (id: string): void => {
        emit?.({
          type: 'tool_call',
          id,
          name: 'Read',
          input: {},
          parentToolUseId: 'toolu_task_1',
        });
      };

      delegateRow('call-1');
      await drain();
      expect((await runDao.getById(run.id))?.status).toBe('running');

      // Four minutes in — still inside the window — a second row re-arms it.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      await drain();
      delegateRow('call-2');
      await drain();

      // Eight minutes after the FIRST row: past its own expiry, and four
      // minutes into the renewed one.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      await drain();
      expect((await runDao.getById(run.id))?.status).toBe('running');

      // Nothing renews it now, so the renewed window is the one that expires.
      await vi.advanceTimersByTimeAsync(60 * 1000 + 1);
      await drain();
      expect((await runDao.getById(run.id))?.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start a SECOND lease acquisition while one is in flight', async () => {
    // The off-turn dispatcher is fire-and-forget, so rows parsed from one
    // stdout chunk run concurrently. Both used to find the map empty, both read
    // the run, and both armed a timer — the second `set` orphaning the first,
    // leaving an expiry nothing can refresh or clear that hands the badge back
    // five minutes after the FIRST row however many rows arrived since.
    //
    // What is asserted is the single-flight itself, on the real DAO: while one
    // acquisition is parked in the read, a second row must not open its own.
    // The badge cannot show this — a row landing after an orphan fires takes a
    // fresh lease and puts `running` straight back, so every later reading is
    // the recovery rather than the drop.
    const { service, claude, runDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();

    const realGetById = runDao.getById.bind(runDao);
    const parked: (() => void)[] = [];
    let holding = true;
    runDao.getById = async (id: string) => {
      const row = await realGetById(id);
      if (!holding) {
        return row;
      }
      await new Promise<void>((resolve) => parked.push(resolve));
      return row;
    };

    const delegateRow = (id: string): void => {
      claude.sessions[0]?.onBetweenTurnEvent?.({
        type: 'tool_call',
        id,
        name: 'Read',
        input: {},
        parentToolUseId: 'toolu_task_1',
      });
    };

    delegateRow('call-a');
    await drain();
    delegateRow('call-b');
    await drain();

    // One acquisition in flight, not two.
    expect(parked).toHaveLength(1);

    holding = false;
    for (const release of parked) {
      release();
    }
    await drain();
    expect((await realGetById(run.id))?.status).toBe('running');
  });

  it('refuses an effort the NAMED MODEL does not list, at chat creation', async () => {
    // The user-visible half of the model-aware check. Passing no model here
    // makes `accepts` lenient by design, so a creation path that dropped
    // `input.model` would let the level straight through — the value would be
    // stored on the run and re-warned about by the driver every turn instead.
    const { service, cursor, efforts } = setup();
    vi.spyOn(
      cursor.adapter as unknown as CursorAcpAdapter,
      'listModelEfforts',
    ).mockResolvedValue({
      efforts: [
        { id: 'low', label: 'Low' },
        { id: 'high', label: 'High' },
      ],
      unavailableReason: null,
      exact: true,
    });
    // What the picker's own fetch does; the refusal consults only a listing
    // already held, so that it never spawns on the creation path.
    await efforts.list('cursor-agent', 'grok-4.6');

    await expect(
      service.createChat({
        agentKind: 'cursor-agent',
        cwd: process.cwd(),
        model: 'grok-4.6',
        effort: 'ultracode',
      }),
    ).rejects.toThrow(/does not accept the reasoning effort/i);

    // …and a level that model DOES list is created without complaint.
    const created = await service.createChat({
      agentKind: 'cursor-agent',
      cwd: process.cwd(),
      model: 'grok-4.6',
      effort: 'high',
    });
    expect(created.effort).toBe('high');
  });

  it('checks a settings patch against the model the patch LEAVES the run on', async () => {
    // Checking the OLD model would refuse a level only the incoming one offers,
    // which is the whole reason the patch's own model wins here.
    const { service, cursor, efforts } = setup();
    vi.spyOn(
      cursor.adapter as unknown as CursorAcpAdapter,
      'listModelEfforts',
    ).mockImplementation(async (model) => ({
      efforts:
        model === 'gpt-5.2'
          ? [{ id: 'extra-high', label: 'Extra high' }]
          : [{ id: 'low', label: 'Low' }],
      unavailableReason: null,
      exact: true,
    }));
    const run = await service.createChat({
      agentKind: 'cursor-agent',
      cwd: process.cwd(),
      model: 'grok-4.6',
    });
    // Both models' listings held, so the patch is judged against the one it
    // leaves the run on rather than falling through to leniency.
    await efforts.list('cursor-agent', 'grok-4.6');
    await efforts.list('cursor-agent', 'gpt-5.2');

    const patched = await service.updateSettings(run.id, {
      model: 'gpt-5.2',
      effort: 'extra-high',
    });

    expect(patched.effort).toBe('extra-high');
  });

  it('does not start a SECOND off-turn restate while one is in flight', async () => {
    // The twin of the lease claim, and the same single-flight: a main-thread
    // delta burst arrives fire-and-forget, so without the claim two deltas both
    // read the run before either records the flip.
    const { service, claude, runDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();

    const realGetById = runDao.getById.bind(runDao);
    const parked: (() => void)[] = [];
    let holding = true;
    runDao.getById = async (id: string) => {
      const row = await realGetById(id);
      if (!holding) {
        return row;
      }
      await new Promise<void>((resolve) => parked.push(resolve));
      return row;
    };

    claude.sessions[0]?.onBetweenTurnEvent?.({ type: 'text_delta', text: 'a' });
    await drain();
    claude.sessions[0]?.onBetweenTurnEvent?.({ type: 'text_delta', text: 'b' });
    await drain();

    expect(parked).toHaveLength(1);

    holding = false;
    for (const release of parked) {
      release();
    }
    await drain();
    expect((await realGetById(run.id))?.status).toBe('running');
  });

  it('releases the lease claim when the run read THROWS', async () => {
    // The claim is taken before the read and the caller swallows a rejection
    // (`handleBetweenTurnEvent` logs and carries on), so without a `finally`
    // one failed read strands it — every later delegate row then returns at the
    // claim guard, no lease is ever taken again, and the badge sits on
    // `completed` while sub-agents keep producing rows.
    const { service, claude, runDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();

    const realGetById = runDao.getById.bind(runDao);
    let failNext = true;
    runDao.getById = async (id: string) => {
      if (failNext) {
        failNext = false;
        throw new Error('database went away');
      }
      return realGetById(id);
    };

    const delegateRow = (id: string): void => {
      claude.sessions[0]?.onBetweenTurnEvent?.({
        type: 'tool_call',
        id,
        name: 'Read',
        input: {},
        parentToolUseId: 'toolu_task_1',
      });
    };

    delegateRow('call-a');
    await drain();
    // The read failed, so no lease — but the run must not be left unleasable.
    expect((await realGetById(run.id))?.status).toBe('completed');

    delegateRow('call-b');
    await drain();
    expect((await realGetById(run.id))?.status).toBe('running');
  });

  it('leaves a CANCELLED run cancelled while its delegate rows arrive', async () => {
    // Stop is final on this path too — the rows are still written, because the
    // work happened, but the badge the user asked for stands.
    const { service, claude, runDao, itemDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    await service.cancel(run.id);
    claude.emit({ type: 'turn_cancelled' });
    claude.finish();
    await drain();
    expect((await runDao.getById(run.id))?.status).toBe('cancelled');
    const before = itemDao.items.length;

    claude.sessions[0]?.onBetweenTurnEvent?.({
      type: 'tool_call',
      id: 'call-9',
      name: 'Read',
      input: {},
      parentToolUseId: 'toolu_task_1',
    });
    await drain();

    expect((await runDao.getById(run.id))?.status).toBe('cancelled');
    expect(itemDao.items).toHaveLength(before + 1);
  });

  it('hands the badge back once a leased delegate goes quiet', async () => {
    // The off-switch a delegate cannot provide itself. Without it this is the
    // latch the row path refuses to build: `still working` on screen with
    // nothing left able to take it down.
    // ONLY the timer the lease uses. `drain()` waits on `setImmediate`, which a
    // blanket `useFakeTimers()` also replaces — every await in this file would
    // then hang rather than the expiry being controllable.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { service, claude, runDao, statuses } = setup();
      const run = await service.createChat({
        agentKind: 'claude',
        cwd: process.cwd(),
      });
      await service.sendMessage(run.id, 'go');
      await drain();
      claude.emit({
        type: 'turn_complete',
        usage: null,
        stopReason: null,
        finalText: null,
      });
      claude.finish();
      await drain();

      claude.sessions[0]?.onBetweenTurnEvent?.({
        type: 'tool_call',
        id: 'call-9',
        name: 'Read',
        input: {},
        parentToolUseId: 'toolu_task_1',
      });
      await drain();
      expect((await runDao.getById(run.id))?.status).toBe('running');
      statuses.length = 0;

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      await drain();

      // Back to the status the lease took it from, not to some third word.
      expect((await runDao.getById(run.id))?.status).toBe('completed');

      // And announced as a RESTORE. Without the flag the client reads this as a
      // fresh non-terminal→terminal crossing and fires a second `turn ended`
      // banner for a turn that ended minutes ago; without the summary being
      // WITHHELD, the null besides blanks the sentence the real settle gave it.
      const announce = statuses.at(-1);
      expect(announce?.status).toBe('completed');
      expect(announce?.restored).toBe(true);
      expect(announce && 'summary' in announce).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands the badge back when the CLI session closes under an off-turn run', async () => {
    // REPORTED twice over, as "seems like its stuck" and "It finished but
    // stucked - i have to ask about a status to continue". Reconstructed from
    // the author's own geniro.db and debug log, run 1fb3a9f5 on 2026-08-22:
    // the last off-turn row landed at 11:33:52, the idle window closed the CLI
    // session at 11:33:55 — and nothing was announced ever again. The run row
    // sat `running` under `still working`, the composer stayed on "Agent is
    // working — your message will queue…", and the only way out was to send a
    // message, which is precisely what the second report describes doing.
    //
    // The hole is that an off-turn `running` ends ONLY on a terminal event.
    // A delegate lease at least has an expiry; this latch has none, so when the
    // process that owed the terminal event is closed the badge has nothing left
    // that could ever take it down.
    const { service, claude, runDao, statuses, sessions } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();
    expect((await runDao.getById(run.id))?.status).toBe('completed');

    // A MAIN-THREAD row off-turn — no `parentToolUseId`, so this is the latch
    // rather than the lease, and there is no timer anywhere in the picture.
    claude.sessions[0]?.onBetweenTurnEvent?.({
      type: 'tool_call',
      id: 'call-9',
      name: 'Bash',
      input: {},
    });
    await drain();
    expect((await runDao.getById(run.id))?.status).toBe('running');
    statuses.length = 0;

    sessions.close(run.id);
    await drain();

    expect((await runDao.getById(run.id))?.status).toBe('completed');
    // A RESTORE for the same reason the lease expiry is one: the turn this
    // hands back to ended minutes ago, and announced as an ordinary settle it
    // is a second non-terminal→terminal crossing the client reads as a fresh
    // ending — a duplicate "turn ended" banner for work long finished.
    const announce = statuses.at(-1);
    expect(announce?.status).toBe('completed');
    expect(announce?.restored).toBe(true);
  });

  it('says in the TRANSCRIPT when the close cut the agent off mid-work', async () => {
    // The badge restore above is right and, on its own, a lie by omission: the
    // status it hands back is the one the off-turn stretch took over — usually
    // `completed`, from a turn that ended before the agent carried on — so a
    // cut-off agent left a thread reading `completed` with its work unfinished
    // and nothing anywhere naming what had happened. REPORTED as "Тред сам по
    // себе остановился … я должен писать ему какое-то сообщение, чтобы он
    // продолжил", against a run whose CLI had been closed one second after its
    // last row.
    const { service, claude, runDao, itemDao, sessions } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();

    claude.sessions[0]?.onBetweenTurnEvent?.({
      type: 'tool_call',
      id: 'call-9',
      name: 'Bash',
      input: {},
    });
    await drain();
    expect((await runDao.getById(run.id))?.status).toBe('running');

    sessions.close(run.id);
    await drain();

    expect(
      itemDao.items.some(
        (item) =>
          item.kind === 'system' &&
          item.payload.includes('geniro closed its process') &&
          item.payload.includes('"severity":"warning"'),
      ),
    ).toBe(true);
  });

  it('says nothing when the close merely reaped a session that had gone quiet', async () => {
    // The other half, and what keeps the row from becoming noise: every chat's
    // session is closed eventually — by the idle window, by a daemon that is
    // shutting down — and a warning on each of those would put a red row in
    // every conversation the user owns, about nothing.
    const { service, claude, itemDao, sessions } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();

    sessions.close(run.id);
    await drain();

    expect(
      itemDao.items.some(
        (item) =>
          item.kind === 'system' &&
          item.payload.includes('geniro closed its process'),
      ),
    ).toBe(false);
  });

  it('settles a delegate-leased run on the continuation’s own result', async () => {
    // The lease is an off-turn `running` like any other, so the continuation
    // the delegate provoked settles it through the ordinary path — the expiry
    // is only the backstop for a delegate that never provokes one.
    const { service, claude, runDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();

    const emit = claude.sessions[0]?.onBetweenTurnEvent;
    emit?.({
      type: 'tool_call',
      id: 'call-9',
      name: 'Read',
      input: {},
      parentToolUseId: 'toolu_task_1',
    });
    await drain();
    expect((await runDao.getById(run.id))?.status).toBe('running');

    emit?.({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    await drain();

    expect((await runDao.getById(run.id))?.status).toBe('completed');
  });

  it('settles the run again on the continuation’s own result', async () => {
    // The other half: without this the run would be left `running` forever by
    // the row above, which is the same lie pointing the other way.
    const { service, claude, runDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();

    const emit = claude.sessions[0]?.onBetweenTurnEvent;
    emit?.({ type: 'tool_call', id: 'call-9', name: 'Bash', input: {} });
    await drain();
    expect((await runDao.getById(run.id))?.status).toBe('running');

    emit?.({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    await drain();

    expect((await runDao.getById(run.id))?.status).toBe('completed');
  });

  it('records a CANCELLED run’s trailing work without moving its badge', async () => {
    // The reason a filter was put here in the first place, kept as a rule of
    // its own: after a Stop the cancelled turn's tail still arrives, and a
    // straggling result flipping `cancelled` back to `completed` tells the user
    // their Stop did not take. The rows are still written — the work happened,
    // and a transcript that hides it is lying in the other direction.
    const { service, claude, runDao, itemDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    await service.cancel(run.id);
    // The CLI answers an interrupt with a cancelled turn, which is what
    // actually writes the status — `cancel` itself deliberately writes nothing.
    claude.emit({ type: 'turn_cancelled' });
    claude.finish();
    await drain();
    expect((await runDao.getById(run.id))?.status).toBe('cancelled');
    const before = itemDao.items.length;

    const emit = claude.sessions[0]?.onBetweenTurnEvent;
    emit?.({ type: 'tool_call', id: 'call-9', name: 'Bash', input: {} });
    emit?.({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    await drain();

    expect(itemDao.items.length).toBeGreaterThan(before);
    expect((await runDao.getById(run.id))?.status).toBe('cancelled');
  });

  it('keeps the resume id the CLI reports during its own continuation', async () => {
    // The continuation is part of this conversation, so its session id is what
    // a later `--resume` has to reach. Dropping it left the chat resuming a
    // session missing everything the CLI did after the turn settled.
    const { service, claude, nodeDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    nodeDao.saved.length = 0;

    claude.sessions[0]?.onBetweenTurnEvent?.({
      type: 'session',
      sessionId: 'sid-after-the-turn',
    });
    await drain();

    expect(nodeDao.saved).toContain('sid-after-the-turn');
  });

  it('files what the CLI reports about itself off-turn under the same folder', async () => {
    // `mcp_servers` and `slash_commands` are the CLI describing its OWN state,
    // which is as true off-turn as on. Dropping them meant a continuation's
    // reading — often the freshest one there is — never reached the panels.
    const { service, claude, skillHarvest, mcpHarvest } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    const emit = claude.sessions[0]?.onBetweenTurnEvent;
    emit?.({
      type: 'slash_commands',
      commands: [{ name: '/review', description: null }],
    });
    emit?.({
      type: 'mcp_servers',
      servers: [
        {
          name: 'playwright',
          status: 'connected',
          target: 'npx -y @playwright/mcp',
          transport: 'stdio',
          detail: null,
        },
      ],
    });
    await drain();

    expect(skillHarvest.record).toHaveBeenCalledWith(
      'claude',
      process.cwd(),
      null,
      [{ name: '/review', description: null }],
    );
    expect(mcpHarvest.record).toHaveBeenCalledWith(
      'claude',
      process.cwd(),
      null,
      [
        {
          name: 'playwright',
          status: 'connected',
          target: 'npx -y @playwright/mcp',
          transport: 'stdio',
          detail: null,
        },
      ],
    );
  });

  it('routes an off-turn live signal to the tail, never to the transcript', async () => {
    // The words the CLI streams during its own continuation are the only thing
    // on screen while it runs, and dropping them left the user watching a
    // finished-looking chat grow rows with nothing above them. They go to the
    // SAME live tail an in-turn delta does — no row of their own, because the
    // completed `text` that follows is the durable copy.
    const { service, claude, itemDao, deltas } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    const before = itemDao.items.length;
    deltas.length = 0;

    claude.sessions[0]?.onBetweenTurnEvent?.({
      type: 'text_delta',
      text: 'still going…',
    });
    await drain();

    expect(deltas.at(-1)?.text).toContain('still going…');
    expect(itemDao.items).toHaveLength(before);
  });

  it('puts the badge back to running while the CLI is only THINKING off-turn', async () => {
    // "It show as completed, but its actually thinking" — a live `Thinking…`
    // row under a `✓ done` footer, with the sidebar still saying `completed`.
    // A think produces NO row, so the row-driven restate could never see it,
    // and on a long one there is nothing else to see for minutes.
    const { service, claude, runDao, statuses } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();
    expect((await runDao.getById(run.id))?.status).toBe('completed');
    statuses.length = 0;

    claude.sessions[0]?.onBetweenTurnEvent?.({
      type: 'thinking_progress',
      tokens: 500,
    });
    await drain();

    expect((await runDao.getById(run.id))?.status).toBe('running');
    expect(statuses.at(-1)?.activity).toContain('still working');
  });

  it('announces the flip ONCE across a burst of off-turn deltas', async () => {
    // A delta arrives many times a second and the phrase never changes, so the
    // flip is the whole announcement. Without the short-circuit each one reads
    // the run back out of the database — which is what the read count below
    // pins, and the only half a test can see: the single BROADCAST survives the
    // short-circuit's removal either way, because the `run.status === 'running'`
    // guard downstream stops the second write on its own.
    const { service, claude, runDao, statuses } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();
    statuses.length = 0;

    const realGetById = runDao.getById.bind(runDao);
    let reads = 0;
    runDao.getById = async (id: string) => {
      reads += 1;
      return realGetById(id);
    };

    for (const text of ['one ', 'two ', 'three ']) {
      claude.sessions[0]?.onBetweenTurnEvent?.({ type: 'text_delta', text });
      await drain();
    }

    expect(reads).toBe(1);
    expect((await realGetById(run.id))?.status).toBe('running');
    expect(statuses).toHaveLength(1);
  });

  it('ignores a DELEGATE’s off-turn thinking — that is not the run working', async () => {
    // The same rule the off-turn ROW path follows: a delegate winding up opens
    // no turn of its own, so nothing would ever take the spinner back down.
    const { service, claude, runDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();

    claude.sessions[0]?.onBetweenTurnEvent?.({
      type: 'thinking_progress',
      tokens: 500,
      parentToolUseId: 'toolu_a',
    });
    await drain();

    expect((await runDao.getById(run.id))?.status).toBe('completed');
  });

  it('leaves a CANCELLED run cancelled when the CLI thinks on regardless', async () => {
    // Stop is final. A straggling think flipping the badge back would tell the
    // user their Stop did not take.
    const { service, claude, runDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    claude.emit({ type: 'turn_cancelled' });
    claude.finish();
    await drain();
    expect((await runDao.getById(run.id))?.status).toBe('cancelled');

    claude.sessions[0]?.onBetweenTurnEvent?.({
      type: 'thinking_progress',
      tokens: 500,
    });
    await drain();

    expect((await runDao.getById(run.id))?.status).toBe('cancelled');
  });

  it('leaves a settled run alone — cancel is not a way to reopen it', async () => {
    const { service, runDao, itemDao } = setup();
    const run = await runDao.create({ status: 'completed', workflowId: null });
    await service.cancel(run.id);
    expect((await runDao.getById(run.id))?.status).toBe('completed');
    expect(itemDao.items).toHaveLength(0);
  });

  it('lets the turn finalizer settle a LIVE run instead of racing it', async () => {
    const { service, claude, runDao, statuses } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    statuses.length = 0;

    expect(await service.cancel(run.id)).toEqual({ cancelled: true });
    // Cancel wrote nothing itself — a write here would race the finalizer.
    expect(statuses).toEqual([]);
    claude.finish();
    await drain();
    expect((await runDao.getById(run.id))?.status).not.toBe('running');
  });

  it('announces every status change, so a background badge cannot go stale', async () => {
    const { service, claude, statuses } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    expect(statuses).toContainEqual({
      runId: run.id,
      status: 'running',
      activity: null,
      // Every status write says the run is parked on nothing: a settle sweeps
      // its cards first, and the only non-terminal write is a fresh turn's.
      awaiting: null,
      // …and WHEN the row was written, which is what the sidebar orders on.
      // Only a write carries it: the activity announce a few tests below
      // asserts its own exact shape, and that one has no `at` in it.
      at: expect.any(String) as unknown as string,
    });

    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();
    expect(statuses.at(-1)).toEqual({
      runId: run.id,
      status: 'completed',
      activity: null,
      awaiting: null,
      at: expect.any(String) as unknown as string,
      // A settle the agent said nothing on carries an explicit null, never a
      // missing field: the client holds the last sentence it was given, so an
      // absent one leaves the PREVIOUS turn's closing words standing and this
      // wordless turn announces them as its own.
      summary: null,
    });
  });

  it('carries the agent’s closing words into the settle announcement', async () => {
    // What a background thread's notification is worded from. The run ROW
    // cannot serve: `lastMessage` is enriched by list endpoints only, so for a
    // chat nobody has open it still holds the user's own message from before
    // the turn — a banner reading your own prompt back at you.
    const { service, claude, statuses } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    claude.emit({ type: 'text', text: 'Fixed the parser — 3 tests green.' });
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();

    expect(statuses.at(-1)).toMatchObject({
      runId: run.id,
      status: 'completed',
      summary: 'Fixed the parser — 3 tests green.',
    });
  });

  it('marks a turn that did nothing but COMPACT as housekeeping', async () => {
    // `/compact` is an ordinary turn on the wire — the user's command, the
    // CLI's summary row, a terminal item — so it settled the run like any
    // other and earned a system banner plus a sidebar mark for a piece of
    // context management the user had just asked for and could see. Reported
    // as "don't need a notification when the compact fires".
    const { service, claude, statuses } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, '/compact');
    await drain();

    claude.emit({
      type: 'context_compacted',
      phase: 'finished',
      trigger: 'manual',
      preTokens: 539_800,
      postTokens: 16_500,
    });
    claude.emit({
      type: 'notice',
      message: 'This session is being continued…',
      origin: 'cli',
    });
    // A row of the USER's own is not work — it is the instruction that asked
    // for the compaction. Counted, it would take the exemption straight back
    // off the very turn this exists for.
    claude.emit({ type: 'user_message', text: '/compact' });
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();

    expect(statuses.at(-1)).toEqual({
      runId: run.id,
      status: 'completed',
      activity: null,
      awaiting: null,
      at: expect.any(String) as unknown as string,
      summary: null,
      housekeeping: true,
    });
  });

  it('does NOT mark a turn that compacted and then did real work', async () => {
    // An AUTOMATIC compaction lands in the middle of a turn that is working,
    // and that turn's ending is the one the user is waiting to hear about. The
    // exemption is decided from what the turn PRODUCED, so a single assistant
    // message is enough to take it away — which is what stops this from being
    // "any turn containing a compaction is silent".
    const { service, claude, statuses } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    claude.emit({
      type: 'context_compacted',
      phase: 'finished',
      trigger: 'auto',
      preTokens: 539_800,
      postTokens: 16_500,
    });
    claude.emit({
      type: 'notice',
      message: 'This session is being continued…',
      origin: 'cli',
    });
    claude.emit({ type: 'text', text: 'Fixed the parser — 3 tests green.' });
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();

    expect(statuses.at(-1)).toEqual({
      runId: run.id,
      status: 'completed',
      activity: null,
      awaiting: null,
      at: expect.any(String) as unknown as string,
      summary: 'Fixed the parser — 3 tests green.',
    });
  });

  it('announces a FAILED and a CANCELLED settle too, not just the happy one', async () => {
    // "every status change" is only true if the terminal ones are covered, and
    // a failed or cancelled run is precisely the badge that lies longest. The
    // completed-only assertion above passes with the announce dropped from
    // every other call site.
    const failed = setup();
    const failedRun = await failed.service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await failed.service.sendMessage(failedRun.id, 'go');
    await drain();
    failed.claude.emit({ type: 'error', message: 'the CLI died' });
    failed.claude.finish();
    await drain();
    expect(failed.statuses.at(-1)).toEqual({
      runId: failedRun.id,
      status: 'failed',
      activity: null,
      awaiting: null,
      at: expect.any(String) as unknown as string,
      // The failure's OWN message rides the announcement: the client that has
      // to act on it is the one not looking at this chat, and a notification
      // saying only "the turn failed" sends the user to find out what did.
      summary: 'the CLI died',
    });

    const cancelled = setup();
    const liveRun = await cancelled.runDao.create({
      status: 'running',
      workflowId: null,
    });
    await cancelled.service.cancel(liveRun.id);
    expect(cancelled.statuses.at(-1)).toEqual({
      runId: liveRun.id,
      status: 'cancelled',
      activity: null,
      awaiting: null,
      at: expect.any(String) as unknown as string,
      summary: null,
    });
  });

  it('names what a running turn is DOING, not just that it is running', async () => {
    const { service, claude, statuses } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    claude.emit({ type: 'tool_call', id: 't1', name: 'Bash', input: {} });
    await drain();
    expect(statuses).toContainEqual({
      runId: run.id,
      // The activity announce asserts NO status — it never read the run.
      status: null,
      activity: 'running Bash',
      // Exact equality, so the ABSENT `at` is pinned here: this announce
      // touches no row, and stamping it would put every client's sidebar order
      // ahead of the database until the next refetch pulled it back.
    });
    claude.finish();
    await drain();
  });

  it('stops claiming a tool is running once that tool has returned', async () => {
    // The reported defect: a finished answer sitting under a live row that read
    // "running Read · 7m 57s". The phrase is only ever REPLACED by the next
    // tool call, so the last tool of a turn kept its present tense for as long
    // as the turn stayed open — and a turn held on background work stays open
    // for up to the silence deadline.
    const { service, claude, statuses } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    claude.emit({ type: 'tool_call', id: 't1', name: 'Read', input: {} });
    await drain();
    expect(statuses.at(-1)?.activity).toBe('running Read');

    claude.emit({
      type: 'tool_result',
      id: 't1',
      name: 'Read',
      result: 'ok',
      isError: false,
    });
    await drain();
    // Null, not another phrase: between tools the agent is thinking, which is
    // what the run's own "Working…" already says.
    expect(statuses.at(-1)).toEqual({
      runId: run.id,
      status: null,
      activity: null,
    });
    claude.finish();
    await drain();
  });

  it('keeps naming a tool that is still out when a SIBLING of its batch returns', async () => {
    // The other half of the same complaint ("the Running Edit line lags"): a
    // model routinely issues several tool calls in ONE assistant message and
    // their results come back one at a time. Tracked as a boolean, the phrase
    // was retired by whichever finished FIRST — so a slow `Edit` batched with a
    // fast `Read` stopped being named the instant the Read returned, and the
    // row said "Working…" about a turn that was demonstrably editing a file.
    const { service, claude, statuses } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    claude.emit({ type: 'tool_call', id: 't1', name: 'Read', input: {} });
    claude.emit({ type: 'tool_call', id: 't2', name: 'Edit', input: {} });
    await drain();
    expect(statuses.at(-1)?.activity).toBe('running Edit');

    claude.emit({
      type: 'tool_result',
      id: 't1',
      name: 'Read',
      result: 'ok',
      isError: false,
    });
    await drain();
    // The Edit is still out, so it is still what the run is doing.
    expect(statuses.at(-1)?.activity).toBe('running Edit');

    claude.emit({
      type: 'tool_result',
      id: 't2',
      name: 'Edit',
      result: 'ok',
      isError: false,
    });
    await drain();
    expect(statuses.at(-1)?.activity).toBeNull();
    claude.finish();
    await drain();
  });

  it('says what the approved tool is doing again once the card is answered', async () => {
    // Measured on a real `ask` turn: a 30s command sat under "Working… 11s"
    // from the moment Approve was pressed. Parking clears the phrase (correct —
    // nothing is running while the user decides), but the approved call had
    // already announced itself BEFORE the card went up and never announces
    // again, so the clear outlived the wait it described.
    const { service, claude, statuses, approvals } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    claude.emit({ type: 'tool_call', id: 't1', name: 'Bash', input: {} });
    await drain();
    expect(statuses.at(-1)?.activity).toBe('running Bash');

    claude.emit({
      type: 'approval_request',
      id: 'a-1',
      toolName: 'Bash',
      input: {},
    });
    await drain();
    // Parked: no phrase, because nothing moves without the user.
    expect(statuses.at(-1)).toEqual({
      runId: run.id,
      status: null,
      activity: null,
      awaiting: 'approval',
    });

    expect(approvals.resolve(run.id, 'a-1', true)).toBe(true);
    await drain();
    // The AWAITING announce, not simply the last event: answering also records
    // user activity, which lands after it and says only when — see
    // `noteUserActivity`. This test is about what the run goes back to DOING.
    expect(
      statuses.filter((event) => event.awaiting !== undefined).at(-1),
    ).toEqual({
      runId: run.id,
      status: null,
      activity: 'running Bash',
      awaiting: null,
    });

    claude.emit({
      type: 'tool_result',
      id: 't1',
      name: 'Bash',
      result: 'ok',
      isError: false,
    });
    await drain();
    expect(statuses.at(-1)?.activity).toBeNull();
    claude.finish();
    await drain();
  });

  it('says what a held turn is WAITING ON, not the last tool it ran', async () => {
    // The reported "it finished, but it says it's still in process": the turn is
    // held open while background work it started has not reported, which is
    // deliberate — but the row went on naming the last tool, so a live delegate
    // and a dead one looked identical.
    //
    // Driven by `turn_held`, which is what `runCliSession` actually emits. The
    // first version of this counted `background_work` events instead, and
    // `spawn-cli` consumes those as turn plumbing and never forwards them — so
    // the branch under test could only ever run from a spec.
    const { service, claude, statuses } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    claude.emit({ type: 'tool_call', id: 't1', name: 'Read', input: {} });
    await drain();
    expect(statuses.at(-1)?.activity).toBe('running Read');

    claude.emit({ type: 'turn_held', open: 2 });
    await drain();
    // The agent has STOPPED — so the tool it left open is not running either,
    // and the run says what it is actually waiting for.
    expect(statuses.at(-1)).toEqual({
      runId: run.id,
      status: null,
      activity: 'waiting on 2 sub-agents',
      holdingFor: 2,
    });

    claude.emit({ type: 'turn_held', open: 1 });
    await drain();
    expect(statuses.at(-1)?.activity).toBe('waiting on 1 sub-agent');

    claude.emit({ type: 'turn_held', open: 0 });
    await drain();
    // Nothing outstanding — back to the run's own "Working…", and the composer
    // is told the hold is over in the same breath.
    expect(statuses.at(-1)).toEqual({
      runId: run.id,
      status: null,
      activity: null,
      holdingFor: 0,
    });
    claude.finish();
    await drain();
  });

  it('counts a DETACHED command on the run, and clears it when it reports', async () => {
    // REPORTED as "when i select thread - it bacame working status, but when
    // unselect - successs. So it's blinking". The renderer folded "a command is
    // still out" from the OPEN thread's transcript, which is answerable for one
    // run and for no other — so a settled chat with a `sleep` still running
    // badged itself `working` while selected and `completed` the instant it was
    // not. A count on the run row is the only thing that fixes it, and this is
    // the announce that carries it to every window.
    //
    // Driven by `shell_open`/`shell_info` rather than by `background_work`, for
    // the reason written on the held-turn spec above: `spawn-cli` consumes the
    // bracket as turn plumbing and never forwards it, so a recorder written
    // against it runs from a spec and never from the app. (It was written that
    // way first, and the real app is what caught it.)
    const { service, claude, statuses } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    claude.emit({
      type: 'shell_open',
      toolCallId: 'toolu_sh',
      workId: 'bash_1',
    });
    await drain();
    expect(statuses.at(-1)).toEqual({
      runId: run.id,
      status: null,
      shellsOpen: 1,
    });

    // A SECOND command, so the count is a count rather than a flag.
    claude.emit({
      type: 'shell_open',
      toolCallId: 'toolu_sh2',
      workId: 'bash_2',
    });
    await drain();
    expect(statuses.at(-1)?.shellsOpen).toBe(2);

    // The turn ENDING does not clear it — which is the whole point of the
    // field. A detached command outlives its turn, and that stretch is exactly
    // when the badge is the only thing saying the work is not over.
    claude.finish();
    await drain();
    expect(
      (await service.listChats()).find((r) => r.id === run.id)?.shellsOpen,
    ).toBe(2);

    claude.emit({
      type: 'shell_info',
      toolCallId: 'toolu_sh',
      workId: 'bash_1',
    });
    await drain();
    expect(statuses.at(-1)?.shellsOpen).toBe(1);

    // A DUPLICATE close announces nothing: claude reports one unit's end on
    // both of its terminal channels, 7ms apart, so a count that decremented per
    // report would go to 0 with a command still running.
    const before = statuses.length;
    claude.emit({
      type: 'shell_info',
      toolCallId: 'toolu_sh',
      workId: 'bash_1',
    });
    await drain();
    expect(statuses.length).toBe(before);

    claude.emit({
      type: 'shell_info',
      toolCallId: 'toolu_sh2',
      workId: 'bash_2',
    });
    await drain();
    expect(statuses.at(-1)?.shellsOpen).toBe(0);
    expect(
      (await service.listChats()).find((r) => r.id === run.id)?.shellsOpen,
    ).toBe(0);
  });

  it('does NOT clear the parent’s activity on a SUB-AGENT’s tool result', async () => {
    // The mirror of the announce rule below: a delegate's results arrive on the
    // same stream, and clearing on one would take down the "running Agent" that
    // is the truth for the whole delegation.
    const { service, claude, statuses } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    claude.emit({ type: 'tool_call', id: 't1', name: 'Agent', input: {} });
    await drain();
    claude.emit({
      type: 'tool_result',
      id: 'sub',
      name: 'Read',
      result: 'ok',
      isError: false,
      parentToolUseId: 't1',
    });
    await drain();
    expect(statuses.at(-1)?.activity).toBe('running Agent');
    claude.finish();
    await drain();
  });

  it('does NOT rename the run’s activity after a SUB-AGENT’s tool call', async () => {
    // Measured on a real delegating turn before the fix: two sub-agents running
    // four Bash commands each produced eight consecutive `running Bash`
    // announces on the PARENT run, none of them the parent's own work. The
    // transcript already split their rows into their own blocks; this channel
    // was the one that still carried them upward.
    const { service, claude, statuses } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    // The delegation itself IS the parent's work, and is announced.
    claude.emit({ type: 'tool_call', id: 't1', name: 'Agent', input: {} });
    // What the delegate then does is not.
    claude.emit({
      type: 'tool_call',
      id: 't2',
      name: 'Bash',
      input: {},
      parentToolUseId: 't1',
    });
    await drain();

    expect(statuses).toContainEqual({
      runId: run.id,
      status: null,
      activity: 'running Agent',
    });
    expect(statuses).not.toContainEqual({
      runId: run.id,
      status: null,
      activity: 'running Bash',
    });
    claude.finish();
    await drain();
  });

  it('takes the compaction phrase back DOWN when it finishes, rather than rewording it', async () => {
    // It used to announce a past-tense sentence here, worded by trigger
    // ("compacted the conversation", or "… to free up context"). The activity
    // channel means "what this run is doing right now", and the transcript
    // draws it as a spinning row with a climbing clock — so on a `/compact`,
    // whose whole turn IS the compaction, nothing came along to replace it and
    // the row read `⟳ compacted the conversation · 54s` directly beneath the
    // durable summary that already said it was over.
    //
    // Nothing is lost: the CLI's own summary lands as a `system` row carrying
    // the figures the phrase never had. Measured on the author's own database,
    // 14 compactions produced 14 such rows.
    const { service, claude, statuses } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    claude.emit({
      type: 'context_compacted',
      phase: 'started',
      trigger: 'manual',
      preTokens: null,
      postTokens: null,
    });
    await drain();
    expect(statuses.at(-1)).toEqual({
      runId: run.id,
      status: null,
      activity: 'compacting the conversation',
    });

    for (const trigger of ['manual', 'auto'] as const) {
      claude.emit({
        type: 'context_compacted',
        phase: 'finished',
        trigger,
        preTokens: 180_000,
        postTokens: 20_000,
      });
      await drain();
      // Cleared, whichever asked for it — and asserted as the LAST announce
      // rather than merely present, since the phrase standing is exactly the
      // defect.
      expect(statuses.at(-1)).toEqual({
        runId: run.id,
        status: null,
        activity: null,
      });
    }

    // And no past-tense wording anywhere on the channel.
    expect(
      statuses.filter((s) => (s.activity ?? '').startsWith('compacted')),
    ).toEqual([]);

    claude.finish();
    await drain();
  });

  it('names the compaction WHILE it runs, not only once it is over', async () => {
    // The reported defect: a `/compact` sat on "Working… 29s" with nothing
    // saying why. A compaction measured 46s in the probe behind
    // `CLAUDE_COMPACTING_STATUS`, and until 2.1.227 there was no line to key on.
    // Revert the `started` branch and this fails — the only activity announced
    // would be the post-hoc one, which is the behaviour the user complained of.
    const { service, claude, statuses } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    claude.emit({
      type: 'context_compacted',
      phase: 'started',
      trigger: null,
      preTokens: null,
      postTokens: null,
    });
    await drain();
    expect(statuses).toContainEqual({
      runId: run.id,
      status: null,
      activity: 'compacting the conversation',
    });

    claude.finish();
    await drain();
  });

  it('stops saying a compaction is under way once the CLI reports it failed', async () => {
    // "compacting the conversation" is PRESENT TENSE, so it claims work is
    // happening right now. On the success path the boundary event retracts it
    // with a past-tense phrase; on the failure path there is no boundary and no
    // `finished` phase at all — only the CLI's failure line, which lands as a
    // durable row and announces nothing. So the run goes on reading as still
    // compacting while it has already carried on at full context.
    const { service, claude, statuses, published } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    claude.emit({
      type: 'context_compacted',
      phase: 'started',
      trigger: null,
      preTokens: null,
      postTokens: null,
    });
    await drain();
    expect(statuses.at(-1)?.activity).toBe('compacting the conversation');

    // BOTH events, in the order the mapper returns them for the terminating
    // status line of a compaction that did not happen — the durable reason and
    // the phase that retracts the phrase. See CLAUDE_COMPACT_FAILED_NOTICE.
    claude.emit({
      type: 'notice',
      message:
        'the conversation was not compacted — Not enough messages to compact.',
    });
    claude.emit({
      type: 'context_compacted',
      phase: 'failed',
      trigger: null,
      preTokens: null,
      postTokens: null,
    });
    await drain();

    // The failure reached the transcript AND the phrase came down. Revert the
    // `failed` branch in either the mapper or the announce and this fails: the
    // run keeps reading as "compacting the conversation" after the CLI has
    // already declined, because only the SUCCESS path emits a boundary to
    // supersede it.
    expect(published.some((entry) => entry.item.kind === 'system')).toBe(true);
    expect(statuses.at(-1)?.activity).toBeNull();

    claude.finish();
    await drain();
  });

  it("hands the compaction's own token figures to the summary row that follows", async () => {
    // The boundary has the numbers and no text; the injected summary has the
    // text and no numbers, and neither line can see the other. Without this
    // correlation the transcript has no way to say what the compaction DID, so
    // the summary lands as ten thousand characters of relayed prose with no
    // heading — which is what the renderer collapses it behind.
    const { service, claude, published } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    // The measured order on 2.1.228: boundary first, summary one millisecond
    // later. Reverse these two and the stamp is correctly absent.
    claude.emit({
      type: 'context_compacted',
      phase: 'finished',
      trigger: 'manual',
      preTokens: 200_167,
      postTokens: 34_120,
    });
    claude.emit({
      type: 'notice',
      message: 'This session is being continued…',
      origin: 'cli',
    });
    await drain();

    const summary = published.find((entry) => entry.item.kind === 'system');
    expect(summary?.item.payload).toMatchObject({
      origin: 'cli',
      compaction: { preTokens: 200_167, postTokens: 34_120 },
    });
  });

  it('spends the figures ONCE — a later relayed notice is not that summary', async () => {
    // The marker is what tells the renderer a row IS a compaction summary. Left
    // standing, the next CLI-authored notice of the turn would inherit both the
    // marker and figures that describe something else, and be collapsed behind
    // a heading about a compaction it has nothing to do with.
    const { service, claude, published } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    claude.emit({
      type: 'context_compacted',
      phase: 'finished',
      trigger: 'manual',
      preTokens: 200_167,
      postTokens: 34_120,
    });
    claude.emit({
      type: 'notice',
      message: 'This session is being continued…',
      origin: 'cli',
    });
    claude.emit({
      type: 'notice',
      message: 'some other thing the CLI said',
      origin: 'cli',
    });
    await drain();

    const systemRows = published.filter(
      (entry) => entry.item.kind === 'system',
    );
    expect(systemRows).toHaveLength(2);
    expect(systemRows[0]?.item.payload).toMatchObject({
      compaction: { preTokens: 200_167 },
    });
    expect(systemRows[1]?.item.payload).not.toHaveProperty('compaction');
  });

  it('leaves a DAEMON-authored notice unstamped, compaction or not', async () => {
    // Only text the CLI wrote can be its summary. A daemon advisory that
    // happened to land after a boundary is an advisory, and stamping it would
    // dress geniro's own words as the agent's summary.
    const { service, claude, published } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    claude.emit({
      type: 'context_compacted',
      phase: 'finished',
      trigger: 'auto',
      preTokens: 180_000,
      postTokens: null,
    });
    claude.emit({ type: 'notice', message: 'images were withheld' });
    await drain();

    const advisory = published.find((entry) => entry.item.kind === 'system');
    expect(advisory?.item.payload).not.toHaveProperty('compaction');
  });

  it('says a run is WAITING on the user, which "running" alone cannot', async () => {
    const { service, claude, statuses } = setup({
      claudeModes: {
        acceptEdits: 'pass',
        plan: 'pass',
        version: 'claude-test',
        probedAt: 0,
        reason: null,
      },
    });
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
      approval: 'ask',
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    claude.emit({
      type: 'approval_request',
      id: 'req-1',
      toolName: 'Write',
      input: {},
    });
    await drain();
    // WHICH kind of answer is wanted, because the two are different asks:
    // "waiting for approval" sends the user looking for a button, which is
    // wrong when a prompt is on screen. The sentence itself is the renderer's
    // (`awaitingPhrase`) so it survives a reload; what crosses the wire is the
    // kind — and the activity is cleared, because whatever the run was last
    // said to be doing, it is not doing it while it waits.
    expect(statuses).toContainEqual({
      runId: run.id,
      status: null,
      activity: null,
      awaiting: 'approval',
    });
    claude.finish();
    await drain();
  });
});

describe('ChatService — the live tail belongs to the MAIN thread', () => {
  /** The words the main agent is watched writing, in two deltas. */
  const HEAD = 'Критик запущен. Пока он работает — ';
  const REST = 'вот три варианта.';

  it('does NOT throw the tail away when a DELEGATE lands a message', async () => {
    // The reported defect: a turn streamed, "cut off the first part of the
    // message and streamed out the second one", and the whole message only
    // appeared once its own durable row landed. There is ONE tail per run and
    // it holds the main agent's words; a sub-agent's message is the durable
    // copy of text that was never in it, so retiring on one restarted the
    // bubble mid-sentence.
    const { service, claude, deltas } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    claude.emit({ type: 'tool_call', id: 't1', name: 'Agent', input: {} });
    claude.emit({ type: 'text_delta', text: HEAD });
    await drain();
    expect(deltas.at(-1)?.text).toBe(HEAD);

    // The delegate reporting back — a durable row of its own, under the tool
    // call that launched it.
    claude.emit({
      type: 'text',
      text: 'delegate: both approaches hold',
      parentToolUseId: 't1',
    });
    await drain();
    expect(deltas.at(-1)?.text).toBe(HEAD);

    // …and the main agent's next words EXTEND what is on screen rather than
    // starting a second, headless bubble.
    claude.emit({ type: 'text_delta', text: REST });
    await drain();
    expect(deltas.at(-1)?.text).toBe(`${HEAD}${REST}`);
    claude.finish();
    await drain();
  });

  it('still retires it when the MAIN agent’s own message lands', async () => {
    // The other half, and what stops the fix above from becoming "never
    // retire": the durable row IS those words, so the live copy has to go or
    // the user reads the same sentence twice.
    const { service, claude, deltas } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    claude.emit({ type: 'text_delta', text: HEAD });
    await drain();
    expect(deltas.at(-1)?.text).toBe(HEAD);

    claude.emit({ type: 'text', text: `${HEAD}${REST}` });
    await drain();
    expect(deltas.at(-1)?.text).toBe('');
    claude.finish();
    await drain();
  });

  it('does NOT stop the main agent THINKING because a delegate spoke', async () => {
    // Same rule, same plane: one reasoning stretch per run, and a delegate's
    // rows arrive while the parent is genuinely still reasoning. Ending the
    // stretch on one took the "Thinking…" row off an agent that had not
    // stopped.
    const { service, claude, deltas } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();

    claude.emit({ type: 'tool_call', id: 't1', name: 'Agent', input: {} });
    claude.emit({ type: 'thinking_progress', tokens: 40 });
    await drain();
    expect(deltas.at(-1)?.thinkingStretch).toBe(1);

    claude.emit({
      type: 'text',
      text: 'delegate: done',
      parentToolUseId: 't1',
    });
    await drain();
    expect(deltas.at(-1)?.thinkingStretch).toBe(1);
    claude.finish();
    await drain();
  });
});

describe('ChatService — a DELEGATE winding up is not the run working again', () => {
  /** A settled chat run whose CLI is still holding its session. */
  async function settledRun(harness: ReturnType<typeof setup>) {
    const { service, claude } = harness;
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: process.cwd(),
    });
    await service.sendMessage(run.id, 'go');
    await drain();
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();
    return run;
  }

  it('leaves the badge SETTLED when a delegate’s last row lands after the turn', async () => {
    // Reported: a sub-agent reads `done`, the turn reads `✓ done`, and under
    // them a `still working` spinner counts upward for ever. A delegate is the
    // background work the turn was held for, and its trailing rows land as it
    // FINISHES — so restating them as the run working again announced work at
    // the exact moment it ended, and nothing could take the phrase down: only a
    // terminal event settles this state, and a delegate winding up opens no
    // turn of its own to produce one.
    const harness = setup();
    const { claude, runDao, itemDao, statuses } = harness;
    const run = await settledRun(harness);
    const before = itemDao.items.length;
    statuses.length = 0;

    // The delegate REPORTED — that announcement is what closed its block and
    // made it read `done`, and it is what tells these rows apart from the ones
    // an un-bracketed delegate goes on producing while it works.
    const emit = claude.sessions[0]?.onBetweenTurnEvent;
    emit?.({
      type: 'subagent_info',
      id: 'toolu_task_1',
      label: null,
      kind: null,
      prompt: null,
      model: null,
      durationMs: null,
      tokens: null,
      toolUses: null,
      stepsUnavailableReason: null,
      backgroundOpen: false,
      backgroundOutcome: null,
    });
    emit?.({
      type: 'text',
      text: 'delegate: both approaches hold up',
      parentToolUseId: 'toolu_task_1',
    });
    await drain();

    // The ROW is still written — a transcript that hides work lies the other
    // way — and the badge is left exactly as the turn left it.
    expect(itemDao.items.length).toBeGreaterThan(before);
    expect((await runDao.getById(run.id))?.status).toBe('completed');
    // Nothing that could move the badge or the phrase. This was `toEqual([])`,
    // which was stricter than the promise the test's own name makes: a
    // preview-only announce carries no status and no activity key, so it cannot
    // restate the run as working — and the delegate's line IS the run's latest
    // message row, which is what the next list refetch would show anyway. What
    // is pinned is the badge, which is what was reported.
    expect(
      statuses.filter(
        (event) => event.status !== null || event.activity !== undefined,
      ),
    ).toEqual([]);
  });

  it('still goes back to RUNNING when the CLI itself carries on', async () => {
    // The other half: a task-notification continuation is the CLI opening real
    // work of its own, on the MAIN thread, and it settles again on its own
    // result. Without this the fix above would simply stop reporting the
    // continuation the off-turn path exists for.
    const harness = setup();
    const { claude, runDao } = harness;
    const run = await settledRun(harness);

    const emit = claude.sessions[0]?.onBetweenTurnEvent;
    emit?.({
      type: 'text',
      text: 'the delegate reported — here is the answer',
    });
    await drain();
    expect((await runDao.getById(run.id))?.status).toBe('running');

    emit?.({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    await drain();
    expect((await runDao.getById(run.id))?.status).toBe('completed');
  });
});

describe('ChatService — pointing an open chat at another account', () => {
  let dir: string;
  let profileA: string;
  let profileB: string;
  beforeEach(() => {
    // `realpathSync` because `resolveValidConfigDir` canonicalizes, and on
    // macOS a `mkdtemp` under `/tmp` comes back as `/private/var/…` — an
    // assertion against the raw path would fail for the wrong reason.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'geniro-chat-profile-')));
    profileA = realpathSync(mkdtempSync(join(tmpdir(), 'geniro-profile-a-')));
    profileB = realpathSync(mkdtempSync(join(tmpdir(), 'geniro-profile-b-')));
  });
  afterEach(() => {
    for (const path of [dir, profileA, profileB]) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  const SESSION = 'eeeeeeee-1111-2222-3333-444444444444';

  /** The session file the CLI would have written for this thread. */
  function seedSession(profile: string, text: string): void {
    const projects = join(profile, 'projects', '-a-folder');
    mkdirSync(projects, { recursive: true });
    writeFileSync(
      join(projects, `${SESSION}.jsonl`),
      `${JSON.stringify({ type: 'user', cwd: '/a/folder', message: { role: 'user', content: text } })}\n`,
    );
  }

  it('carries the CLI’s own conversation across, retires the old process, and says so', async () => {
    // REPORTED as "I wanna have ability to dynamically change config directory
    // for current claude threads to have an ability continue thread with other
    // account", and the second half is what this pins. geniro's transcript
    // never moves; the CLI's memory lives in the profile, and `--resume` under
    // a profile that does not hold the file answers "No conversation found"
    // (probed on 2.1.237 across two real accounts). A switch that only rewrote
    // the column would hand the user an agent with amnesia under a transcript
    // still showing the conversation it had forgotten.
    const { service, claude, nodeDao, runDao, published } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      configDir: profileA,
    });
    // One turn, so the run holds a live process AND a session id — the two
    // things a switch has to deal with.
    await service.sendMessage(run.id, 'hello');
    claude.finish();
    await drain();
    await nodeDao.saveSessionId(run.id, SINGLE_AGENT_NODE, SESSION);
    seedSession(profileA, 'the codeword is PLUM');
    // A context count and a kept metrics reading, both taken under profile A —
    // the two account-scoped things a move has to decide about.
    await runDao.rememberContext(run.id, { contextTokens: 4321 });
    await runDao.rememberMetricsReading(run.id, '{"plan":{"plan":"team"}}');
    expect(claude.sessions[0]?.closed).toBe(false);

    const updated = await service.updateSettings(run.id, {
      configDir: profileB,
    });

    expect(updated.configDir).toBe(profileB);
    // The conversation is now where the new profile looks for it.
    expect(
      readFileSync(
        join(profileB, 'projects', '-a-folder', `${SESSION}.jsonl`),
        'utf8',
      ),
    ).toContain('the codeword is PLUM');
    // The live process was spawned with the OLD profile in its env and can
    // never be told otherwise, so leaving it would serve the next turn from
    // the account the user just switched away from.
    expect(claude.sessions[0]?.closed).toBe(true);
    const notice = published
      .map((event) => event.item.payload as { message?: string } | null)
      .find((payload) => payload?.message?.includes('Now running as'));
    // The profile by its LAST SEGMENT: the note is a centred one-line row, and
    // an absolute path ran to four lines on screen.
    expect(notice?.message).toContain(basename(profileB));
    expect(notice?.message).toContain('its conversation came too');
    // Every reading this run holds was taken from the OLD account. The kept
    // metrics reading carries that account's PLAN LIMITS, so serving it after
    // the move reports one subscription's plan under another's name.
    expect(runDao.runs.get(run.id)?.lastMetricsReading).toBeNull();
    // The conversation CAME ALONG, so the count still measures it — clearing
    // here would blank a meter that is telling the truth.
    expect(runDao.runs.get(run.id)?.contextTokens).toBe(4321);
  });

  it('refuses mid-turn, because the turn is writing into the profile being left', async () => {
    // `model` and `effort` are accepted on a claimed run — they only describe
    // the NEXT turn. This one does more than describe: a copy taken now would
    // carry a conversation missing its last minutes, and retiring the process
    // under a running turn kills work the user asked for.
    const { service, registry, nodeDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      configDir: profileA,
    });
    await nodeDao.saveSessionId(run.id, SINGLE_AGENT_NODE, SESSION);
    seedSession(profileA, 'mid-turn');

    expect(registry.tryClaim(run.id)).toBe(true);
    await expect(
      service.updateSettings(run.id, { configDir: profileB }),
    ).rejects.toThrow('still working');
    registry.release(run.id);

    // Nothing was copied on the refused attempt — a half-done switch is worse
    // than none, since the file would then be in a profile the run is not on.
    expect(existsSync(join(profileB, 'projects'))).toBe(false);
    // …and it goes through once the turn is over.
    const updated = await service.updateSettings(run.id, {
      configDir: profileB,
    });
    expect(updated.configDir).toBe(profileB);
  });

  it('refuses while a SUB-AGENT is still working, after its turn has settled', async () => {
    // The hole a registry-only guard leaves, and the one that would cost real
    // work. `ProcessRegistry` tracks TURNS; a delegate routinely outlives the
    // one that launched it, going on producing rows after the `result` line —
    // which is why `leaseOnDelegateRow` puts the badge back to `running` with
    // no turn claimed. In that window a registry-only check would let the
    // switch through, and the switch CLOSES the run's CLI process: the
    // sub-agent lives inside it, so its work would be killed mid-flight and
    // the session file copied halfway through being appended to.
    const { service, claude, nodeDao, runDao } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      configDir: profileA,
    });
    await nodeDao.saveSessionId(run.id, SINGLE_AGENT_NODE, SESSION);
    seedSession(profileA, 'a delegate is out');
    // A turn that has ENDED — nothing claimed, no process registered.
    await service.sendMessage(run.id, 'launch a sub-agent');
    claude.emit({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    claude.finish();
    await drain();
    expect(runDao.runs.get(run.id)?.status).toBe('completed');

    // …and then the delegate speaks, which is the whole of the window.
    claude.sessions[0]?.onBetweenTurnEvent?.({
      type: 'text',
      text: 'delegate still going',
      parentToolUseId: 'sub-1',
    });
    await drain();
    expect(runDao.runs.get(run.id)?.status).toBe('running');

    await expect(
      service.updateSettings(run.id, { configDir: profileB }),
    ).rejects.toThrow('sub-agents');
    // The process it lives in is untouched, and nothing was copied out from
    // under it.
    expect(claude.sessions[0]?.closed).toBe(false);
    expect(existsSync(join(profileB, 'projects'))).toBe(false);
    expect(runDao.runs.get(run.id)?.configDir).toBe(profileA);
  });

  it('refuses a CLI that cannot be pointed at a profile at all', async () => {
    // The adapter owns the verdict, so no agent is named in the service. The
    // honest answer for a chat is "no" rather than a silently dropped field:
    // the profile is picked one control away from the agent picker.
    const { service } = setup();
    const run = await service.createChat({
      agentKind: 'cursor-agent',
      cwd: dir,
    });

    await expect(
      service.updateSettings(run.id, { configDir: profileB }),
    ).rejects.toThrow('would not change the subscription');
  });

  it('switches anyway when the conversation could NOT come along, and says the agent starts fresh', async () => {
    // A carry refusal is not a switch refusal. The user asked to run as
    // another account and that is legitimate whether or not the CLI's memory
    // can follow — what would be wrong is doing it silently, since the
    // transcript on screen still shows a conversation the agent no longer has.
    const { service, nodeDao, runDao, published } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      configDir: profileA,
    });
    // A session id with no file behind it: the profile no longer holds it.
    await nodeDao.saveSessionId(run.id, SINGLE_AGENT_NODE, SESSION);
    // Seeded so the clear below is observable — a count that was never set
    // would assert null whether or not the move cleared anything.
    await runDao.rememberContext(run.id, { contextTokens: 4321 });

    const updated = await service.updateSettings(run.id, {
      configDir: profileB,
    });

    expect(updated.configDir).toBe(profileB);
    const notice = published
      .map((event) => event.item.payload as { message?: string } | null)
      .find((payload) => payload?.message?.includes('Now running as'));
    expect(notice?.message).toContain('fresh conversation from here');
    expect(notice?.message).toContain('no longer holds this conversation');
    // The conversation did NOT come along, so the count measures one that is
    // gone — the same rule a compaction takes, which is this event from inside.
    expect(runDao.runs.get(run.id)?.contextTokens).toBeNull();
  });

  it('says nothing and copies nothing when the pick is the profile already in use', async () => {
    // A picker can re-choose what is already chosen, and that is not an event:
    // a notice would put a line in the transcript about nothing happening, and
    // retiring the process would cost a cold start for the same reason.
    const { service, claude, published } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      configDir: profileA,
    });
    await service.sendMessage(run.id, 'hello');
    claude.finish();
    await drain();
    const before = published.length;

    const updated = await service.updateSettings(run.id, {
      configDir: profileA,
    });

    expect(updated.configDir).toBe(profileA);
    expect(published).toHaveLength(before);
    expect(claude.sessions[0]?.closed).toBe(false);
  });
});

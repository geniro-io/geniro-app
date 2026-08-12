import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CallTokenRegistry } from '../../../auth/call-token.registry';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import type {
  AgentApprovalMode,
  AgentEvent,
  AgentTurnInput,
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
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { FakeContextWindowStore } from './__tests__/fake-context-window-store';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentEventBus } from './agent-events.bus';
import { AgentSessionRegistry } from './agent-session.registry';
import { ApprovalRegistry } from './approval-registry';
import type { AttachmentStoreService } from './attachment-store.service';
import { ChatService } from './chat.service';
import { EffortsService } from './efforts.service';
import { ItemSeqAllocator } from './item-seq.allocator';
import type { McpHarvestStore } from './mcp-harvest.store';
import { PartialStreamService } from './partial-stream.service';
import { ProcessRegistry } from './process-registry';
import { RunTeardownService } from './run-teardown.service';
import type { SkillHarvestStore } from './skill-harvest.store';

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
  async listChats(): Promise<Run[]> {
    return [...this.runs.values()];
  }
  async listRunningChats(): Promise<Run[]> {
    // Mirrors the real query's chat-only scoping (workflowId null).
    return [...this.runs.values()].filter(
      (run) => run.status === 'running' && run.workflowId === null,
    );
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
  async saveSessionId(
    runId: string,
    nodeId: string,
    sessionId: string,
  ): Promise<void> {
    void runId;
    void nodeId;
    this.saved.push(sessionId);
    this.state = { agentSessionId: sessionId } as unknown as NodeState;
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
      } = {},
    ) => {
      const record = {
        closed: false,
        betweenTurnApproval: opts.betweenTurnApproval,
        onBetweenTurnEvent: opts.onBetweenTurnEvent,
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
    kind === 'claude' ? new ClaudeAdapter() : new CursorAcpAdapter();
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
  opts: { claudeModes?: ClaudeModesCapability; mcpSettingsFile?: string } = {},
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
  const efforts = new EffortsService(adapters);
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
  const service = new ChatService(
    em,
    runDao as unknown as RunDao,
    itemDao as unknown as ItemDao,
    nodeDao as unknown as NodeStateDao,
    bus,
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
    // Most tests toggle nothing, so the default points at a path that never
    // exists — a mkdtemp per setup() would leak one directory per TEST. The
    // tests that DO exercise the switch pass a real file.
  );
  return {
    service,
    deltas,
    partials,
    callTokens,
    statuses,
    deletedRuns,
    removedAttachmentRuns,
    runDao,
    itemDao,
    nodeDao,
    published,
    registry,
    approvals,
    claude,
    cursor,
    claudeProbe,
    skillHarvest,
    mcpHarvest,
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
    claude.emit({ type: 'slash_commands', commands: ['deploy', 'compact'] });
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
      ['deploy', 'compact'],
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

    // A chat carries no config directory — only a graph node does — and this
    // null must match the key the panel's own read builds, or the harvest is
    // written somewhere nothing ever looks.
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
    const { service, runDao, registry, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    claude.start.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });

    await expect(service.sendMessage(run.id, 'go')).rejects.toThrow(
      'spawn failed',
    );

    expect((await runDao.getById(run.id))?.status).toBe('failed');
    expect(registry.has(run.id)).toBe(false);
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

  it('refuses an effort the run CLI does not list — an unknown claude level, and ANY level on cursor', async () => {
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

    // cursor-agent lists nothing at all — it folds effort into the model id.
    const cursorRun = await service.createChat({
      agentKind: 'cursor-agent',
      cwd: dir,
    });
    await expect(
      service.updateSettings(cursorRun.id, { effort: 'high' }),
    ).rejects.toThrow(
      "cursor-agent does not accept the reasoning effort 'high'",
    );

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
        contextTokens: 1_000,
        contextWindowTokens: 1_000_000,
        contextModel: 'claude-opus-5[1m]',
        costUsd: null,
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

  it('still drops a between-turn event that has nothing to anchor it', async () => {
    // The narrowness is the safety argument: a stray message or delta carries
    // no id pairing it to anything, and filing one turn's words under another's
    // is worse than dropping them. This is the assertion that fails if the
    // filter is ever widened to "persist whatever arrives".
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
      text: 'a stray sentence from the turn that was stopped',
    });
    await drain();

    expect(itemDao.items).toHaveLength(before);
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
    });
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

  it('announces that the conversation was compacted, and words it by trigger', async () => {
    // C1's ONLY user-visible half. The two shipped specs pin the parse and the
    // not-a-transcript-row drop; delete this announcement entirely and both
    // stay green, so the one thing the user actually sees was unpinned.
    //
    // It exists to explain a momentary event: the context meter dropping by
    // most of the window between one request and the next, which with nothing
    // said reads as the meter being broken.
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
      preTokens: 180_000,
      postTokens: 20_000,
    });
    await drain();
    expect(statuses).toContainEqual({
      runId: run.id,
      status: null,
      activity: 'compacted the conversation to free up context',
    });

    // A compaction the USER asked for is not explained as housekeeping — they
    // know why it happened, so the reason is dropped rather than restated.
    claude.emit({
      type: 'context_compacted',
      phase: 'finished',
      trigger: 'manual',
      preTokens: 180_000,
      postTokens: 20_000,
    });
    await drain();
    expect(statuses).toContainEqual({
      runId: run.id,
      status: null,
      activity: 'compacted the conversation',
    });

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
    expect(statuses).toContainEqual({
      runId: run.id,
      status: null,
      activity: 'waiting for approval',
    });
    claude.finish();
    await drain();
  });
});

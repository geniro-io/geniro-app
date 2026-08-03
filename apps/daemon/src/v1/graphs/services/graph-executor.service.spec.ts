import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import type { BadRequestException } from '@packages/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CallTokenRegistry } from '../../../auth/call-token.registry';
import type {
  AdapterConfig,
  AdapterQuestion,
  AgentApprovalMode,
  AgentEvent,
  AgentTurnInput,
  ApprovalResolution,
  InstalledApprovalSupport,
  InstalledCapabilities,
} from '../../agents/adapters/adapter.types';
import type { AgentAdapter } from '../../agents/adapters/agent-adapter';
import { ClaudeAdapter } from '../../agents/adapters/claude/claude.adapter';
import type { ClaudeProbeService } from '../../agents/adapters/claude/claude-probe.service';
import { CursorAcpAdapter } from '../../agents/adapters/cursor-acp/cursor-acp.adapter';
import type {
  ClaudeModesCapability,
  CursorCallsCapability,
} from '../../agents/chat.types';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { NodeStateDao } from '../../agents/dao/node-state.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ApprovalRegistry } from '../../agents/services/approval-registry';
import type { AttachmentStoreService } from '../../agents/services/attachment-store.service';
import { McpSettingsStore } from '../../agents/services/mcp-settings.store';
import { PartialStreamService } from '../../agents/services/partial-stream.service';
import { ProcessRegistry } from '../../agents/services/process-registry';
import { RunTeardownService } from '../../agents/services/run-teardown.service';
import type { SkillHarvestStore } from '../../agents/services/skill-harvest.store';
import type { Item } from '../../runs/entity/item.entity';
import type { NodeState } from '../../runs/entity/node-state.entity';
import type { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import type { Workflow } from '../graphs.types';
import { CallBroker } from './call-broker.service';
import { GraphExecutorService } from './graph-executor.service';
import type { WorkflowStoreService } from './workflow-store.service';

// ── In-memory fakes (mirroring chat.service.spec's harness) ──────────────────
class FakeRunDao {
  readonly runs = new Map<string, Run>();
  /** Every `hardDeleteIncludingSoftDeleted` call, so the spec can spy it. */
  readonly hardDeleted: unknown[] = [];
  /**
   * When set, the run-row purge blocks on it — a test seam for the window in
   * which a delete is IN FLIGHT: cancelled and past its own guards, but with
   * the run row still present, which is precisely the state a re-read cannot
   * detect and only the `deleting` Set covers.
   */
  purgeGate: Promise<void> | null = null;
  failNextStatus: string | null = null;
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
    if (data.status === this.failNextStatus) {
      this.failNextStatus = null;
      throw new Error('SQLITE_FULL');
    }
    const run = this.runs.get(id);
    if (!run) {
      return 0;
    }
    Object.assign(run, data);
    return 1;
  }
  async listRunningWorkflowRuns(): Promise<Run[]> {
    return [...this.runs.values()].filter(
      (run) =>
        run.workflowId !== null &&
        (run.status === 'running' || run.status === 'pending'),
    );
  }
}

class FakeItemDao {
  readonly items: Item[] = [];
  /** Every `hardDeleteIncludingSoftDeleted` call, so the spec can spy it. */
  readonly hardDeleted: unknown[] = [];
  failNextKind: string | null = null;
  async hardDeleteIncludingSoftDeleted(where: {
    runId: string;
  }): Promise<number> {
    this.hardDeleted.push(where);
    let removed = 0;
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i]!.runId === where.runId) {
        this.items.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
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
}

interface FakeNodeRow {
  runId: string;
  nodeId: string;
  status: string;
  agentSessionId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
}

class FakeNodeStateDao {
  readonly rows = new Map<string, FakeNodeRow>();
  /** Every `hardDeleteIncludingSoftDeleted` call, so the spec can spy it. */
  readonly hardDeleted: unknown[] = [];
  private key(runId: string, nodeId: string): string {
    return `${runId}:${nodeId}`;
  }
  async hardDeleteIncludingSoftDeleted(where: {
    runId: string;
  }): Promise<number> {
    this.hardDeleted.push(where);
    let removed = 0;
    for (const [key, row] of this.rows) {
      if (row.runId === where.runId) {
        this.rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
  row(runId: string, nodeId: string): FakeNodeRow | undefined {
    return this.rows.get(this.key(runId, nodeId));
  }
  async getByRunNode(runId: string, nodeId: string): Promise<NodeState | null> {
    return (this.row(runId, nodeId) as unknown as NodeState) ?? null;
  }
  async listByRun(runId: string): Promise<NodeState[]> {
    return [...this.rows.values()].filter(
      (r) => r.runId === runId,
    ) as unknown as NodeState[];
  }
  async createPending(runId: string, nodeId: string): Promise<void> {
    this.rows.set(this.key(runId, nodeId), {
      runId,
      nodeId,
      status: 'pending',
      agentSessionId: null,
      startedAt: null,
      endedAt: null,
      error: null,
    });
  }
  async setStatus(
    runId: string,
    nodeId: string,
    patch: {
      status: string;
      startedAt?: number;
      endedAt?: number;
      error?: string | null;
    },
  ): Promise<void> {
    const existing = this.row(runId, nodeId) ?? {
      runId,
      nodeId,
      status: patch.status,
      agentSessionId: null,
      startedAt: null,
      endedAt: null,
      error: null,
    };
    existing.status = patch.status;
    if (patch.startedAt !== undefined) {
      existing.startedAt = patch.startedAt;
    }
    if (patch.endedAt !== undefined) {
      existing.endedAt = patch.endedAt;
    }
    if (patch.error !== undefined) {
      existing.error = patch.error;
    }
    this.rows.set(this.key(runId, nodeId), existing);
  }
  async saveSessionId(
    runId: string,
    nodeId: string,
    sessionId: string,
  ): Promise<void> {
    const existing = this.row(runId, nodeId);
    if (existing) {
      existing.agentSessionId = sessionId;
    }
  }
}

/** One controllable in-flight fake turn. */
interface FakeTurn {
  input: AgentTurnInput;
  emit: (event: AgentEvent) => void;
  finish: () => void;
  respondApproval: ReturnType<typeof vi.fn>;
  cancelled: boolean;
}

class FakeAdapter {
  readonly starts: FakeTurn[] = [];
  /** When set, the NEXT start() throws synchronously (prepareTurn-fs failure). */
  throwNextStart: Error | null = null;
  /**
   * The REAL adapter for this kind, delegated to for every CLI-fact
   * declaration. The double fakes the SPAWN, never the contract: a
   * hand-rolled copy of these would let the executor pass against an approval
   * policy or a call-tool gate the shipped adapter does not actually have,
   * which is precisely the drift folding them behind the adapter removes. So
   * `config` is the SHIPPED object itself, by reference — never a restated
   * one, which would go on passing after the real config changed.
   */
  private readonly real: AgentAdapter;
  readonly config: AdapterConfig;
  /**
   * When true the double answers the BASE default for `questionFrom` (null),
   * modelling a CLI that declares a question tool but whose adapter projects
   * nothing out of the payload — the one state the shipped claude adapter
   * cannot produce, and the reason the executor must not park a blank
   * question on a caller.
   */
  projectsNoQuestion = false;
  constructor(readonly kind: 'claude' | 'cursor-agent') {
    this.real =
      kind === 'claude' ? new ClaudeAdapter() : new CursorAcpAdapter();
    this.getConfig = () => this.real.getConfig();
  }
  questionFrom(input: unknown): AdapterQuestion | null {
    return this.projectsNoQuestion ? null : this.real.questionFrom(input);
  }
  withAnswer(input: unknown, answer: string): unknown {
    return this.real.withAnswer(input, answer);
  }
  resolveApprovalMode(
    requested: AgentApprovalMode,
    installed: InstalledApprovalSupport,
  ): ApprovalResolution {
    return this.real.resolveApprovalMode(requested, installed);
  }
  approvalSupportFrom(
    capabilities: InstalledCapabilities,
  ): InstalledApprovalSupport {
    return this.real.approvalSupportFrom(capabilities);
  }
  start(
    input: AgentTurnInput,
    onEvent: (event: AgentEvent) => void,
  ): { done: Promise<void>; cancel: () => void; respondApproval: unknown } {
    if (this.throwNextStart) {
      const err = this.throwNextStart;
      this.throwNextStart = null;
      throw err;
    }
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const respondApproval = vi.fn(() => true);
    const turn: FakeTurn = {
      input,
      emit: onEvent,
      finish: resolveDone,
      respondApproval,
      cancelled: false,
    };
    this.starts.push(turn);
    return {
      done,
      cancel: () => {
        // Mirror the real handle: a cancel emits turn_cancelled then settles.
        turn.cancelled = true;
        onEvent({ type: 'turn_cancelled' });
        resolveDone();
      },
      respondApproval,
    };
  }
}

const drain = async (): Promise<void> => {
  for (let i = 0; i < 25; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function completeTurn(turn: FakeTurn, finalText: string): void {
  turn.emit({ type: 'text', text: finalText });
  turn.emit({
    type: 'turn_complete',
    usage: null,
    stopReason: 'end_turn',
    finalText,
  });
  turn.finish();
}

let dir: string;

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'geniro-exec-')));
  // The run-start MCP self-check probes the daemon's own route over real
  // loopback HTTP — no server listens in unit tests, and a rejecting fetch
  // would append a system item at a nondeterministic time. Stub it green;
  // the failure path gets its own test with a failing stub.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true })),
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function setup(
  runtimePort: number | null = 4870,
  opts: {
    cursorCalls?: CursorCallsCapability;
    claudeModes?: ClaudeModesCapability;
    mergeOk?: boolean;
    gitTracked?: boolean;
    mergeImpl?: () => Promise<unknown>;
    mcpSettingsFile?: string;
  } = {},
): {
  service: GraphExecutorService;
  claude: FakeAdapter;
  cursor: FakeAdapter;
  runDao: FakeRunDao;
  itemDao: FakeItemDao;
  nodeDao: FakeNodeStateDao;
  registry: ProcessRegistry;
  approvals: ApprovalRegistry;
  callTokens: CallTokenRegistry;
  callBroker: CallBroker;
  ensureVerdict: ReturnType<typeof vi.fn>;
  claudeEnsureVerdict: ReturnType<typeof vi.fn>;
  mergeAcquire: ReturnType<typeof vi.fn>;
  mergeReleases: ReturnType<typeof vi.fn>[];
  deletedRuns: string[];
  removedAttachmentRuns: string[];
} {
  const claude = new FakeAdapter('claude');
  const cursor = new FakeAdapter('cursor-agent');
  const runDao = new FakeRunDao();
  const itemDao = new FakeItemDao();
  const nodeDao = new FakeNodeStateDao();
  const registry = new ProcessRegistry();
  const approvals = new ApprovalRegistry();
  const callTokens = new CallTokenRegistry();
  const callBroker = new CallBroker();
  // Probe verdict defaults to 'unknown' — cursor callers stay shut out unless
  // a test opts into a 'pass' explicitly (mirrors a machine never probed).
  const cursorCalls: CursorCallsCapability = opts.cursorCalls ?? {
    status: 'unknown',
    version: null,
    probedAt: null,
    reason: null,
  };
  const ensureVerdict = vi.fn(async () => cursorCalls);
  // Claude mode probe defaults to all-pass — the widened modes run as
  // requested unless a test opts into a probed FAIL explicitly.
  const claudeModes: ClaudeModesCapability = opts.claudeModes ?? {
    acceptEdits: 'pass',
    plan: 'pass',
    version: 'claude-test',
    probedAt: 0,
    reason: null,
  };
  const claudeEnsureVerdict = vi.fn(async () => claudeModes);
  const claudeProbe = {
    capability: () => claudeModes,
    ensureVerdict: claudeEnsureVerdict,
    wireCapability: () => claudeModes,
  } as unknown as ClaudeProbeService;
  const mergeReleases: ReturnType<typeof vi.fn>[] = [];
  const mergeAcquire = vi.fn(async () => {
    if (opts.mergeImpl) {
      return opts.mergeImpl();
    }
    if (opts.mergeOk === false) {
      return { ok: false as const, reason: 'merge refused (test)' };
    }
    const release = vi.fn();
    mergeReleases.push(release);
    return {
      ok: true as const,
      gitTracked: opts.gitTracked ?? false,
      release,
    };
  });
  const em = { fork: () => ({ clear: () => {} }) } as unknown as EntityManager;
  const skillHarvest = {
    record: vi.fn(),
    get: () => null,
  } as unknown as SkillHarvestStore;
  const storeGet = vi.fn();
  const workflowStore = { get: storeGet } as unknown as WorkflowStoreService;
  // A real bus, tapped: run-status announcements are a wire-visible effect of
  // every status write, so the spec observes the real stream rather than a stub.
  const bus = new AgentEventBus();
  const statusEvents: { runId: string; status: string }[] = [];
  bus.allStatuses().subscribe((event) => {
    statusEvents.push({ runId: event.runId, status: event.status });
  });
  const deletedRuns: string[] = [];
  bus.allDeleted().subscribe((runId) => deletedRuns.push(runId));
  const removedAttachmentRuns: string[] = [];
  const attachments = {
    removeRun: (runId: string) => removedAttachmentRuns.push(runId),
  } as unknown as AttachmentStoreService;
  // The REAL teardown over the same fakes — `deleteRun` is a thin caller of
  // it, so a stub here would leave the delete tests pinning the stub.
  const teardown = new RunTeardownService(
    itemDao as unknown as ItemDao,
    nodeDao as unknown as NodeStateDao,
    runDao as unknown as RunDao,
    bus,
    registry,
    callTokens,
    new PartialStreamService(bus),
    attachments,
  );
  const service = new GraphExecutorService(
    em,
    runDao as unknown as RunDao,
    itemDao as unknown as ItemDao,
    nodeDao as unknown as NodeStateDao,
    bus,
    registry,
    approvals,
    new AgentAdapterRegistry(
      claude as unknown as ClaudeAdapter,
      cursor as unknown as CursorAcpAdapter,
    ),
    callTokens,
    callBroker,
    claudeProbe,
    skillHarvest,
    workflowStore,
    teardown,
    {
      token: 'launch-token',
      version: '0.0.0-test',
      startedAt: 0,
      port: runtimePort,
    },
    new McpSettingsStore({
      // Most tests toggle nothing, so the default points at a path that never
      // exists — a mkdtemp per setup() would leak one directory per TEST. The
      // tests that DO exercise the switch pass a real file.
      file:
        opts.mcpSettingsFile ??
        join(tmpdir(), 'geniro-exec-spec-never-written.json'),
    }),
  );
  return {
    service,
    claude,
    cursor,
    runDao,
    itemDao,
    nodeDao,
    registry,
    approvals,
    callTokens,
    callBroker,
    ensureVerdict,
    claudeEnsureVerdict,
    mergeAcquire,
    mergeReleases,
    skillHarvest,
    storeGet,
    statusEvents,
    deletedRuns,
    removedAttachmentRuns,
  };
}

/**
 * Prepend a manual trigger wired to every root: runs may only enter through a
 * trigger, so every fixture below goes through this before startRun. The
 * trigger spawns no CLI, so `claude.starts[0]` is still the first AGENT turn.
 */
function triggered(workflow: Workflow): Workflow {
  const hasIncoming = new Set(workflow.edges.map((e) => e.to));
  const roots = workflow.nodes.filter((n) => !hasIncoming.has(n.id));
  return {
    ...workflow,
    nodes: [
      { id: 'start', kind: 'trigger', trigger: 'manual' },
      ...workflow.nodes,
    ],
    edges: [
      ...roots.map((r) => ({ from: 'start', to: r.id, kind: 'data' as const })),
      ...workflow.edges,
    ],
  };
}

const LINEAR: Workflow = {
  name: 'linear',
  nodes: [
    { id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' },
    {
      id: 'b',
      kind: 'agent',
      name: 'Reviewer',
      agent: 'claude',
      approval: 'auto',
    },
  ],
  edges: [{ from: 'a', to: 'b', kind: 'data' as const }],
};

describe('GraphExecutorService', () => {
  it('ANNOUNCES a COMPLETED settle, so a workflow row in the sidebar goes live too', async () => {
    // The chat sidebar lists workflow runs beside chats. The chat path writes
    // status through a helper that also publishes; the executor wrote the
    // column directly, so a workflow run settled in SQLite while its badge kept
    // reading "running" until something forced a refetch — item 17 fixed for
    // one row type and left broken for the other.
    const { service, claude, runDao, statusEvents } = setup();
    const run = await service.startRun({
      slug: 'one',
      workflow: triggered({
        name: 'one',
        nodes: [{ id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' }],
        edges: [],
      }),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    completeTurn(claude.starts[0]!, 'done');
    await drain();

    expect(runDao.runs.get(run.id)?.status).toBe('completed');
    // The terminal status reached the wire, not just the row.
    expect(statusEvents).toContainEqual({
      runId: run.id,
      status: 'completed',
    });
  });

  it('announces a FAILED settle too — the badge that lies longest', async () => {
    // Asserting only the happy path leaves the four other setRunStatus sites
    // unpinned, and `failed`/`cancelled` are exactly the states the stale-badge
    // defect was reported against.
    const { service, claude, runDao, statusEvents } = setup();
    const run = await service.startRun({
      slug: 'one',
      workflow: triggered({
        name: 'one',
        nodes: [{ id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' }],
        edges: [],
      }),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    claude.starts[0]!.emit({ type: 'error', message: 'the CLI died' });
    claude.starts[0]!.finish();
    await drain();

    expect(runDao.runs.get(run.id)?.status).toBe('failed');
    expect(statusEvents).toContainEqual({ runId: run.id, status: 'failed' });
  });

  it('runs a call-edge workflow: the callee is on-demand, the broker gets the run', async () => {
    // Milestone-2 replaces the M1 GRAPH_CALL_RUNTIME_UNAVAILABLE guard: a
    // call-only callee never launches with the DAG (it runs per CallBroker
    // call), stays out of the settled denominator, and ends 'skipped' when
    // the run finishes uncalled; the broker surface dies with the run.
    const { service, claude, runDao, nodeDao, callBroker } = setup();
    const run = await service.startRun({
      slug: 'calls',
      workflow: triggered({
        name: 'calls',
        nodes: [
          { id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' },
          { id: 'callee', kind: 'agent', agent: 'claude', approval: 'auto' },
        ],
        edges: [{ from: 'a', to: 'callee', kind: 'call' as const }],
      }),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    // Only the caller launches; the callee waits for calls.
    expect(claude.starts).toHaveLength(1);
    expect(callBroker.hasRun(run.id)).toBe(true);
    expect(callBroker.listCallees(run.id, 'a').map((c) => c.id)).toEqual([
      'callee',
    ]);
    completeTurn(claude.starts[0]!, 'done');
    await drain();
    expect(claude.starts).toHaveLength(1);
    expect(runDao.runs.get(run.id)?.status).toBe('completed');
    expect(nodeDao.row(run.id, 'callee')?.status).toBe('skipped');
    expect(callBroker.hasRun(run.id)).toBe(false);
  });

  it('rejects running an empty workflow (a blank-canvas draft)', async () => {
    // Empty workflows are legal in the library (the builder starts blank) but
    // must never start a run: no run row, no adapter spawn.
    const { service, claude, runDao } = setup();
    let code: string | undefined;
    try {
      await service.startRun({
        slug: 'blank',
        workflow: { name: 'blank', nodes: [], edges: [] },
        cwd: dir,
        prompt: 'go',
      });
    } catch (err) {
      code = (err as BadRequestException).errorCode;
    }
    expect(code).toBe('GRAPH_EMPTY');
    expect(claude.starts).toHaveLength(0);
    expect(runDao.runs.size).toBe(0);
  });

  it('rejects running a workflow with no trigger', async () => {
    const { service, claude, runDao } = setup();
    let code: string | undefined;
    try {
      await service.startRun({
        slug: 'untriggered',
        workflow: {
          name: 'untriggered',
          nodes: [
            { id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' },
          ],
          edges: [],
        },
        cwd: dir,
        prompt: 'go',
      });
    } catch (err) {
      code = (err as BadRequestException).errorCode;
    }
    expect(code).toBe('GRAPH_NO_TRIGGER');
    expect(claude.starts).toHaveLength(0);
    expect(runDao.runs.size).toBe(0);
  });

  it('runs a linear chain, feeding A output into B prompt', async () => {
    const { service, claude, runDao, itemDao, nodeDao } = setup();
    const run = await service.startRun({
      slug: 'linear',
      workflow: triggered(LINEAR),
      cwd: dir,
      prompt: 'build the feature',
    });
    expect(run.workflowId).toBe('linear');
    await drain();

    // The trigger settled instantly (no CLI) and its agent launched with the
    // BARE seed prompt — no empty "## Output from start" section.
    expect(nodeDao.row(run.id, 'start')?.status).toBe('completed');
    expect(claude.starts).toHaveLength(1);
    expect(claude.starts[0]!.input.prompt).toBe('build the feature');
    expect(nodeDao.row(run.id, 'a')?.status).toBe('running');
    expect(nodeDao.row(run.id, 'b')?.status).toBe('pending');

    completeTurn(claude.starts[0]!, 'A final answer');
    await drain();

    // B launched with the seed + upstream output labeled by the producer's id
    // (node a has no display name, so the id is the label).
    expect(claude.starts).toHaveLength(2);
    expect(claude.starts[1]!.input.prompt).toContain('build the feature');
    expect(claude.starts[1]!.input.prompt).toContain('## Output from a');
    expect(claude.starts[1]!.input.prompt).toContain('A final answer');

    completeTurn(claude.starts[1]!, 'B done');
    await drain();

    expect(runDao.runs.get(run.id)?.status).toBe('completed');
    expect(nodeDao.row(run.id, 'a')?.status).toBe('completed');
    expect(nodeDao.row(run.id, 'b')?.status).toBe('completed');

    // Run-level terminal item closes the transcript; seq strictly monotonic.
    const items = itemDao.items;
    const last = items.at(-1)!;
    expect(last.kind).toBe('turn_complete');
    expect(JSON.parse(last.payload).stopReason).toBe('workflow_completed');
    const seqs = items.map((i) => i.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('fans out independent nodes in parallel and joins them', async () => {
    const { service, claude, cursor, runDao, itemDao } = setup();
    const diamond: Workflow = {
      name: 'diamond',
      nodes: [
        { id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' },
        { id: 'b', kind: 'agent', agent: 'claude', approval: 'auto' },
        { id: 'c', kind: 'agent', agent: 'cursor-agent', approval: 'auto' },
        { id: 'd', kind: 'agent', agent: 'claude', approval: 'auto' },
      ],
      edges: [
        { from: 'a', to: 'b', kind: 'data' as const },
        { from: 'a', to: 'c', kind: 'data' as const },
        { from: 'b', to: 'd', kind: 'data' as const },
        { from: 'c', to: 'd', kind: 'data' as const },
      ],
    };
    const run = await service.startRun({
      slug: 'diamond',
      workflow: triggered(diamond),
      cwd: dir,
      prompt: 'task',
    });
    await drain();

    completeTurn(claude.starts[0]!, 'A out');
    await drain();

    // b (claude) and c (cursor) run CONCURRENTLY — both live before either ends.
    expect(claude.starts).toHaveLength(2);
    expect(cursor.starts).toHaveLength(1);

    // Interleave the two live streams before either completes — the seq
    // chain must stay monotonic and collision-free under concurrent emits.
    claude.starts[1]!.emit({ type: 'text', text: 'B chunk 1' });
    cursor.starts[0]!.emit({ type: 'text', text: 'C chunk 1' });
    claude.starts[1]!.emit({ type: 'text', text: 'B chunk 2' });
    cursor.starts[0]!.emit({ type: 'text', text: 'C chunk 2' });
    completeTurn(claude.starts[1]!, 'B out');
    completeTurn(cursor.starts[0]!, 'C out');
    await drain();

    expect(claude.starts).toHaveLength(3);
    const dTurn = claude.starts[2]!;
    expect(dTurn.input.prompt).toContain('B out');
    expect(dTurn.input.prompt).toContain('C out');
    expect(dTurn.input.cwd).toBe(dir); // the shared folder reaches every node

    completeTurn(dTurn, 'D out');
    await drain();
    expect(runDao.runs.get(run.id)?.status).toBe('completed');

    const seqs = itemDao.items.map((i) => i.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("harvests a node turn's slash_commands report for the run cwd, off the transcript", async () => {
    const { service, claude, itemDao, skillHarvest } = setup();
    await service.startRun({
      slug: 'linear',
      workflow: triggered(LINEAR),
      cwd: dir,
      prompt: 'task',
    });
    await drain();

    claude.starts[0]!.emit({
      type: 'slash_commands',
      commands: ['review', 'compact'],
    });
    claude.starts[0]!.finish();
    await drain();

    expect(skillHarvest.record).toHaveBeenCalledWith(
      'claude',
      realpathSync(dir),
      ['review', 'compact'],
    );
    // The report never becomes a transcript row.
    expect(
      itemDao.items.filter((item) => item.payload.includes('compact')),
    ).toEqual([]);
  });

  it('fails a node on error and skips its consumers; the run rolls up failed', async () => {
    const { service, claude, runDao, nodeDao, itemDao } = setup();
    const run = await service.startRun({
      slug: 'linear',
      workflow: triggered(LINEAR),
      cwd: dir,
      prompt: 'task',
    });
    await drain();

    claude.starts[0]!.emit({ type: 'error', message: 'boom' });
    claude.starts[0]!.finish();
    await drain();

    expect(claude.starts).toHaveLength(1); // b never launched
    expect(nodeDao.row(run.id, 'a')?.status).toBe('failed');
    expect(nodeDao.row(run.id, 'b')?.status).toBe('skipped');
    expect(runDao.runs.get(run.id)?.status).toBe('failed');
    const skipItem = itemDao.items.find(
      (i) => i.kind === 'status' && i.nodeId === 'b',
    );
    expect(JSON.parse(skipItem!.payload).status).toBe('skipped');
  });

  it('cancel stops live turns and cancels unstarted nodes', async () => {
    const { service, claude, runDao, nodeDao, registry } = setup();
    const run = await service.startRun({
      slug: 'linear',
      workflow: triggered(LINEAR),
      cwd: dir,
      prompt: 'task',
    });
    await drain();

    expect(registry.has(run.id)).toBe(true);
    await service.cancel(run.id);
    await drain();

    expect(claude.starts[0]!.cancelled).toBe(true);
    expect(nodeDao.row(run.id, 'a')?.status).toBe('cancelled');
    expect(nodeDao.row(run.id, 'b')?.status).toBe('cancelled');
    expect(runDao.runs.get(run.id)?.status).toBe('cancelled');
  });

  it('caps parallel node launches at 4 and drains the queue as slots free', async () => {
    const { service, claude } = setup();
    const wide: Workflow = {
      name: 'wide',
      nodes: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
        id,
        kind: 'agent' as const,
        agent: 'claude' as const,
        approval: 'auto' as const,
      })),
      edges: [],
    };
    await service.startRun({
      slug: 'wide',
      workflow: triggered(wide),
      cwd: dir,
      prompt: 'go',
    });
    await drain();

    // Six ready roots, only four live CLI processes.
    expect(claude.starts).toHaveLength(4);

    completeTurn(claude.starts[0]!, 'done-a');
    await drain();
    expect(claude.starts).toHaveLength(5);

    completeTurn(claude.starts[1]!, 'done-b');
    await drain();
    expect(claude.starts).toHaveLength(6);

    for (const turn of claude.starts.slice(2)) {
      completeTurn(turn, 'done');
    }
    await drain();
    expect(claude.starts).toHaveLength(6);
  });

  it('cancel and getNodeStates reject unknown runs and chat runs (kind guard)', async () => {
    const { service, runDao, registry } = setup();

    await expect(service.cancel('nope')).rejects.toThrow(
      /RUN_NOT_FOUND|not found/,
    );
    await expect(service.getNodeStates('nope')).rejects.toThrow(
      /RUN_NOT_FOUND|not found/,
    );

    const chat = await runDao.create({ workflowId: null, status: 'running' });
    registry.tryClaim(chat.id);
    const cancelled = vi.fn();
    registry.register(chat.id, {
      done: Promise.resolve(),
      cancel: cancelled,
      respondApproval: () => false,
    });

    await expect(service.cancel(chat.id)).rejects.toThrow(
      /NOT_A_WORKFLOW_RUN|not a workflow/,
    );
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('does not report a completed run when a node dies to an external kill (turn_cancelled without cancel())', async () => {
    const { service, claude, runDao, nodeDao, itemDao } = setup();
    const run = await service.startRun({
      slug: 'linear',
      workflow: triggered(LINEAR),
      cwd: dir,
      prompt: 'task',
    });
    await drain();

    // The node's CLI process is killed by a signal from outside the app (OS
    // kill, Activity Monitor, OOM): the handle surfaces turn_cancelled even
    // though nobody called cancel() on the run.
    claude.starts[0]!.emit({ type: 'turn_cancelled' });
    claude.starts[0]!.finish();
    await drain();

    expect(nodeDao.row(run.id, 'a')?.status).toBe('cancelled');
    expect(nodeDao.row(run.id, 'b')?.status).toBe('skipped');
    // A run whose node was killed and whose consumer never ran is not a
    // success — it must roll up failed (or cancelled), never completed.
    expect(['failed', 'cancelled']).toContain(runDao.runs.get(run.id)?.status);
    const last = itemDao.items.at(-1)!;
    expect(last.kind).toBe('turn_complete');
    expect(['workflow_failed', 'workflow_cancelled']).toContain(
      JSON.parse(last.payload).stopReason,
    );
  });

  it('routes an ask-node approval through the registry and persists the pair', async () => {
    const { service, claude, itemDao, approvals } = setup();
    const askFlow: Workflow = {
      name: 'ask',
      nodes: [{ id: 'a', kind: 'agent', agent: 'claude', approval: 'ask' }],
      edges: [],
    };
    const run = await service.startRun({
      slug: 'ask',
      workflow: triggered(askFlow),
      cwd: dir,
      prompt: 'task',
    });
    await drain();

    expect(claude.starts[0]!.input.approvalMode).toBe('ask');
    claude.starts[0]!.emit({
      type: 'approval_request',
      id: 'req-9',
      toolName: 'Write',
      input: { file_path: 'x' },
    });
    await drain();

    expect(approvals.listByRun(run.id)).toHaveLength(1);
    const requestItem = itemDao.items.find(
      (i) => i.kind === 'approval_request',
    );
    expect(JSON.parse(requestItem!.payload)).toMatchObject({
      id: 'req-9',
      toolName: 'Write',
    });

    expect(approvals.resolve(run.id, 'req-9', true)).toBe(true);
    await drain();
    expect(claude.starts[0]!.respondApproval).toHaveBeenCalledWith(
      'req-9',
      true,
      { file_path: 'x' },
    );
    const verdictItem = itemDao.items.find(
      (i) => i.kind === 'approval_verdict',
    );
    expect(JSON.parse(verdictItem!.payload)).toMatchObject({
      id: 'req-9',
      allow: true,
    });

    // Unknown/settled requests report false.
    expect(approvals.resolve(run.id, 'req-9', true)).toBe(false);
    completeTurn(claude.starts[0]!, 'done');
    await drain();
  });

  it('denies the parked node CLI (never hangs) when an approval_request card fails to persist', async () => {
    const { service, claude, itemDao, approvals } = setup();
    const askFlow: Workflow = {
      name: 'ask',
      nodes: [{ id: 'a', kind: 'agent', agent: 'claude', approval: 'ask' }],
      edges: [],
    };
    await service.startRun({
      slug: 'ask',
      workflow: triggered(askFlow),
      cwd: dir,
      prompt: 'task',
    });
    await drain();

    // Persisting the card fails: without a deny-to-unblock the node CLI parks
    // on stdin forever (its aggregate handle never settles, the run wedges).
    itemDao.failNextKind = 'approval_request';
    claude.starts[0]!.emit({
      type: 'approval_request',
      id: 'req-9',
      toolName: 'Write',
      input: { file_path: 'x' },
    });
    await drain();

    // The parked node CLI was auto-denied (unblocked); nothing was tracked,
    // since no verdict could ever have routed to a card that was never shown.
    expect(claude.starts[0]!.respondApproval).toHaveBeenCalledWith(
      'req-9',
      false,
    );
    expect(approvals.listByRun('run-0')).toHaveLength(0);
    completeTurn(claude.starts[0]!, 'done');
    await drain();
  });

  it('fails the node and skips its downstream when settle persistence throws', async () => {
    const { service, claude, runDao, nodeDao, registry } = setup();
    // The bookkeeping write for node a's completion blows up (disk full).
    const original = nodeDao.setStatus.bind(nodeDao);
    let failedOnce = false;
    nodeDao.setStatus = async (runId, nodeId, patch) => {
      if (!failedOnce && nodeId === 'a' && patch.status === 'completed') {
        failedOnce = true;
        throw new Error('SQLITE_FULL');
      }
      return original(runId, nodeId, patch);
    };
    const run = await service.startRun({
      slug: 'linear',
      workflow: triggered(LINEAR),
      cwd: dir,
      prompt: 'task',
    });
    await drain();

    completeTurn(claude.starts[0]!, 'A out');
    await drain();

    expect(claude.starts).toHaveLength(1);
    expect(nodeDao.row(run.id, 'a')).toMatchObject({ status: 'failed' });
    expect(nodeDao.row(run.id, 'b')).toMatchObject({ status: 'skipped' });
    expect(runDao.runs.get(run.id)?.status).toBe('failed');
    expect(registry.has(run.id)).toBe(false);
  });

  it('falls back to failed when the final completed run write throws', async () => {
    const { service, claude, runDao, itemDao, registry } = setup();
    const run = await service.startRun({
      slug: 'one',
      workflow: triggered({
        name: 'one',
        nodes: [{ id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' }],
        edges: [],
      }),
      cwd: dir,
      prompt: 'task',
    });
    await drain();
    runDao.failNextStatus = 'completed';

    completeTurn(claude.starts[0]!, 'done');
    await drain();

    expect(runDao.runs.get(run.id)?.status).toBe('failed');
    expect(
      itemDao.items.some(
        (item) =>
          item.kind === 'turn_complete' &&
          JSON.parse(item.payload).stopReason === 'workflow_completed',
      ),
    ).toBe(false);
    expect(itemDao.items.at(-1)?.kind).toBe('error');
    expect(registry.has(run.id)).toBe(false);
  });

  it('sweeps pending approvals when the turn dies — a late verdict is not applied', async () => {
    const { service, claude, itemDao, approvals } = setup();
    const askFlow: Workflow = {
      name: 'ask',
      nodes: [{ id: 'a', kind: 'agent', agent: 'claude', approval: 'ask' }],
      edges: [],
    };
    const run = await service.startRun({
      slug: 'ask',
      workflow: triggered(askFlow),
      cwd: dir,
      prompt: 'task',
    });
    await drain();

    claude.starts[0]!.emit({
      type: 'approval_request',
      id: 'req-late',
      toolName: 'Bash',
      input: { command: 'ls' },
    });
    await drain();
    expect(approvals.listByRun(run.id)).toHaveLength(1);

    // The node dies with the approval still pending.
    claude.starts[0]!.emit({ type: 'error', message: 'boom' });
    claude.starts[0]!.finish();
    await drain();

    expect(approvals.listByRun(run.id)).toHaveLength(0);
    expect(approvals.resolve(run.id, 'req-late', true)).toBe(false);
    await drain();
    expect(
      itemDao.items.find((i) => i.kind === 'approval_verdict'),
    ).toBeUndefined();
    // …and the transcript SAYS the card is dead. Sweeping alone left it on
    // screen with live buttons; the renderer had to infer staleness from a
    // later terminal item, which it could not do reliably.
    const dead = itemDao.items.find((i) => i.kind === 'unanswerable');
    expect(JSON.parse(dead!.payload)).toEqual({
      id: 'req-late',
      toolName: 'Bash',
      nodeId: 'a',
    });
  });

  it('labels upstream output with the producer display name when set', async () => {
    const { service, claude } = setup();
    const named: Workflow = {
      name: 'named',
      nodes: [
        {
          id: 'a',
          kind: 'agent',
          name: 'Coder',
          agent: 'claude',
          approval: 'auto',
        },
        { id: 'b', kind: 'agent', agent: 'claude', approval: 'auto' },
      ],
      edges: [{ from: 'a', to: 'b', kind: 'data' as const }],
    };
    await service.startRun({
      slug: 'named',
      workflow: triggered(named),
      cwd: dir,
      prompt: 'task',
    });
    await drain();
    completeTurn(claude.starts[0]!, 'from the coder');
    await drain();
    expect(claude.starts[1]!.input.prompt).toContain('## Output from Coder');
  });

  it('reconciles orphaned workflow runs on boot', async () => {
    const { service, runDao, nodeDao, itemDao } = setup();
    // A run left behind by a killed daemon: running, no registry handle.
    const orphan = await runDao.create({
      workflowId: 'ghost',
      status: 'running',
      cwd: dir,
    });
    await nodeDao.createPending(orphan.id, 'a');
    await nodeDao.setStatus(orphan.id, 'a', { status: 'running' });
    await nodeDao.createPending(orphan.id, 'b');

    await service.reconcileOrphanedRuns();

    expect(runDao.runs.get(orphan.id)?.status).toBe('failed');
    expect(nodeDao.row(orphan.id, 'a')?.status).toBe('failed');
    expect(nodeDao.row(orphan.id, 'b')?.status).toBe('skipped');
    const errorItem = itemDao.items.find(
      (i) => i.runId === orphan.id && i.kind === 'error',
    );
    expect(errorItem).toBeDefined();
  });

  it('boot reconcile closes a graph card the KILLED daemon never swept, keeping its node', async () => {
    // Same crash gap as the chat path: the approval registry died with the
    // process, so the only surviving record of an open card is the transcript.
    // The row must stay attributed to the node that asked, or it lands under
    // the run and the card it closes is somewhere else entirely.
    const { service, runDao, nodeDao, itemDao } = setup();
    const orphan = await runDao.create({
      workflowId: 'ghost',
      status: 'running',
      cwd: dir,
    });
    await nodeDao.createPending(orphan.id, 'a');
    await itemDao.create({
      runId: orphan.id,
      nodeId: 'a',
      seq: 0,
      kind: 'approval_request',
      payload: JSON.stringify({ id: 'req-open', toolName: 'Bash' }),
    });

    await service.reconcileOrphanedRuns();

    const dead = itemDao.items.filter(
      (i) => i.runId === orphan.id && i.kind === 'unanswerable',
    );
    expect(dead).toHaveLength(1);
    expect(dead[0]!.nodeId).toBe('a');
    expect(JSON.parse(dead[0]!.payload)).toEqual({
      id: 'req-open',
      toolName: 'Bash',
      nodeId: 'a',
    });
  });
});

describe('GraphExecutorService — agent calls', () => {
  const CALL_WF: Workflow = {
    name: 'calls',
    nodes: [
      {
        id: 'orch',
        kind: 'agent',
        agent: 'claude',
        approval: 'auto',
        role: 'You orchestrate.',
      },
      {
        id: 'helper',
        kind: 'agent',
        name: 'Helper',
        agent: 'claude',
        approval: 'auto',
        description: 'Researches a topic and reports what it found.',
        role: 'You help. Always start by reading SECRET_PLAYBOOK.md.',
      },
    ],
    edges: [{ from: 'orch', to: 'helper', kind: 'call' as const }],
  };

  it('grants the claude caller its MCP endpoint + awareness block; the callee turn stays bare', async () => {
    const { service, claude, callTokens, callBroker, itemDao } = setup();
    const run = await service.startRun({
      slug: 'c',
      workflow: triggered(CALL_WF),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const caller = claude.starts[0]!;
    // Endpoint: this run's route, this caller's node id, the run's token —
    // and the token travels in the input (→ config file), never argv.
    expect(caller.input.mcpEndpoint?.url).toBe(
      `http://127.0.0.1:4870/v1/mcp/${encodeURIComponent(run.id)}/orch`,
    );
    expect(caller.input.mcpEndpoint?.token).toBe(
      callTokens.get(run.id, 'orch'),
    );
    // The token is per caller node: helper (a callee, not a caller) has none.
    expect(callTokens.get(run.id, 'helper')).toBeNull();
    // Awareness: the caller's own role first, then the May-call block naming
    // each callee and what that callee says it DOES...
    expect(caller.input.systemPrompt).toBe('You orchestrate.');
    expect(caller.input.callSurfacePrompt).toContain('May call');
    expect(caller.input.callSurfacePrompt).toContain(
      'Helper (agent id: helper)',
    );
    expect(caller.input.callSurfacePrompt).toContain(
      'Researches a topic and reports what it found.',
    );
    // ...and never how it does it. A callee's role is private, so a caller
    // routes by description alone instead of restating its team in its role.
    expect(caller.input.callSurfacePrompt).not.toContain('SECRET_PLAYBOOK');

    const envelope = callBroker.callAgent(run.id, 'orch', {
      agent: 'helper',
      message: 'help me',
    });
    await drain();
    const callee = claude.starts[1]!;
    // The callee is NOT a caller: bare role, no endpoint, fresh prompt. It
    // gets its own role in FULL — private only means "not shown to callers".
    expect(callee.input.prompt).toBe('help me');
    expect(callee.input.systemPrompt).toBe(
      'You help. Always start by reading SECRET_PLAYBOOK.md.',
    );
    expect(callee.input.mcpEndpoint ?? null).toBeNull();
    completeTurn(callee, 'helped');
    expect(await envelope).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', text: 'helped' },
    });
    // The caller's token is live mid-run; it is revoked once the run settles.
    expect(callTokens.get(run.id, 'orch')).not.toBeNull();
    completeTurn(caller, 'done');
    await drain();
    expect(callTokens.get(run.id, 'orch')).toBeNull();

    // EVERY item of the callee sub-turn — the running/terminal status rows
    // and the streamed items between them — carries the call's id, so the
    // renderer can nest the whole sub-turn under its call block even when
    // parallel calls target the same node. The caller's own items carry none.
    const items = itemDao.items.filter((item) => item.runId === run.id);
    const payloadOf = (item: Item): { callId?: unknown } =>
      JSON.parse(item.payload) as { callId?: unknown };
    const calleeItems = items.filter((item) => item.nodeId === 'helper');
    expect(calleeItems.length).toBeGreaterThanOrEqual(3);
    for (const item of calleeItems) {
      expect(
        payloadOf(item).callId,
        `callee item kind=${item.kind} must carry the callId`,
      ).toBe('call-1');
    }
    // The caller's own STREAMED turn items stay untagged (its call_started/
    // call_result rows carry the callId as call bookkeeping, not as a
    // sub-turn tag).
    const callerTurnItems = items.filter(
      (entry) =>
        entry.nodeId === 'orch' &&
        !['call_started', 'call_result', 'await_collected'].includes(
          entry.kind,
        ),
    );
    expect(callerTurnItems.length).toBeGreaterThanOrEqual(2);
    for (const item of callerTurnItems) {
      expect(payloadOf(item).callId).toBeUndefined();
    }
  });

  it('sync call: transcript rows on the caller, per-call node_state on the callee', async () => {
    const { service, claude, callBroker, itemDao, nodeDao, runDao } = setup();
    const run = await service.startRun({
      slug: 'c',
      workflow: triggered(CALL_WF),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const envelope = callBroker.callAgent(run.id, 'orch', {
      agent: 'Helper',
      message: 'summarize',
    });
    await drain();
    expect(nodeDao.row(run.id, 'helper')?.status).toBe('running');
    completeTurn(claude.starts[1]!, 'summary text');
    expect((await envelope).status).toBe('ok');
    await drain();
    expect(nodeDao.row(run.id, 'helper')?.status).toBe('completed');
    const callItems = itemDao.items.filter((i) =>
      ['call_started', 'call_result'].includes(i.kind),
    );
    expect(callItems.map((i) => [i.kind, i.nodeId])).toEqual([
      ['call_started', 'orch'],
      ['call_result', 'orch'],
    ]);
    completeTurn(claude.starts[0]!, 'done');
    await drain();
    expect(runDao.runs.get(run.id)?.status).toBe('completed');
  });

  it("a callee sub-turn settling does NOT kill the SAME node's still-live DAG-turn approval", async () => {
    // The invariant the renderer's deleted inference tried to reconstruct from
    // callIds in the transcript. A node reachable by BOTH a data edge and a
    // call edge holds two turns at once; the daemon knows which are live, so
    // the card dies only when the node's LAST turn does — never when a callee
    // sub-turn happens to settle first.
    const dualRole: Workflow = {
      name: 'dual',
      nodes: [
        { id: 'start', kind: 'trigger', trigger: 'manual' },
        { id: 'orch', kind: 'agent', agent: 'claude', approval: 'auto' },
        {
          id: 'worker',
          kind: 'agent',
          agent: 'claude',
          approval: 'ask',
          role: 'I am the worker.',
        },
      ],
      edges: [
        { from: 'start', to: 'orch', kind: 'data' as const },
        { from: 'start', to: 'worker', kind: 'data' as const },
        { from: 'orch', to: 'worker', kind: 'call' as const },
      ],
    };
    const { service, claude, callBroker, itemDao, approvals } = setup();
    const run = await service.startRun({
      slug: 'dual',
      workflow: dualRole,
      cwd: dir,
      prompt: 'go',
    });
    await drain();

    const dagTurn = claude.starts.find(
      (t) => t.input.systemPrompt === 'I am the worker.',
    )!;
    dagTurn.emit({
      type: 'approval_request',
      id: 'req-dag',
      toolName: 'Write',
      input: { path: 'x' },
    });
    await drain();
    expect(approvals.listByRun(run.id)).toHaveLength(1);

    // A callee sub-turn on the SAME node runs and settles…
    const envelope = callBroker.callAgent(run.id, 'orch', {
      agent: 'worker',
      message: 'sub-task',
    });
    await drain();
    const calleeTurn = claude.starts[claude.starts.length - 1]!;
    expect(calleeTurn.input.prompt).toBe('sub-task');
    completeTurn(calleeTurn, 'sub-done');
    expect((await envelope).status).toBe('ok');
    await drain();

    // …and the DAG turn's approval is untouched: still answerable, no row.
    expect(approvals.listByRun(run.id)).toHaveLength(1);
    expect(itemDao.items.some((i) => i.kind === 'unanswerable')).toBe(false);

    // Only the node's LAST live turn ending closes the card.
    completeTurn(dagTurn, 'dag-done');
    await drain();
    expect(approvals.listByRun(run.id)).toHaveLength(0);
    const dead = itemDao.items.filter((i) => i.kind === 'unanswerable');
    expect(dead).toHaveLength(1);
    expect(JSON.parse(dead[0]!.payload)).toEqual({
      id: 'req-dag',
      toolName: 'Write',
      nodeId: 'worker',
    });
  });

  it('a live fire-and-forget callee holds the run open until it settles', async () => {
    const { service, claude, callBroker, runDao, nodeDao } = setup();
    const run = await service.startRun({
      slug: 'c',
      workflow: triggered(CALL_WF),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const detached = await callBroker.callAgent(run.id, 'orch', {
      agent: 'helper',
      message: 'background task',
      mode: 'fire_and_forget',
    });
    expect(detached.status).toBe('ok');
    await drain();
    completeTurn(claude.starts[0]!, 'caller done');
    await drain();
    // Every DAG node settled, but the detached callee still runs — the run
    // must NOT roll up yet (sub-turns are out of the denominator but alive).
    expect(runDao.runs.get(run.id)?.status).toBe('running');
    completeTurn(claude.starts[1]!, 'background done');
    await drain();
    expect(runDao.runs.get(run.id)?.status).toBe('completed');
    expect(nodeDao.row(run.id, 'helper')?.status).toBe('completed');
  });

  it('run cancel fans to in-flight callee sub-turns', async () => {
    const { service, claude, callBroker, runDao } = setup();
    const run = await service.startRun({
      slug: 'c',
      workflow: triggered(CALL_WF),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const envelope = callBroker.callAgent(run.id, 'orch', {
      agent: 'helper',
      message: 'never finishes',
    });
    await drain();
    expect(claude.starts).toHaveLength(2);
    await service.cancel(run.id);
    await drain();
    expect(claude.starts[1]!.cancelled).toBe(true);
    const settled = await envelope;
    expect(settled.status).toBe('error');
    expect(settled.error).toContain('CALLEE_CANCELLED');
    expect(runDao.runs.get(run.id)?.status).toBe('cancelled');
  });

  it('reports a failed endpoint self-check as a system item', async () => {
    const { service, claude, itemDao } = setup();
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(
      new Error('ECONNREFUSED'),
    );
    await service.startRun({
      slug: 'c',
      workflow: triggered(CALL_WF),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const note = itemDao.items.find(
      (i) =>
        i.kind === 'system' &&
        JSON.parse(i.payload).message.includes('self-check failed'),
    );
    expect(note).toBeDefined();
    completeTurn(claude.starts[0]!, 'done');
    await drain();
  });

  it('launches every level-2 callee when four 2-deep sync chains run at once', async () => {
    // The sub-turn pool holds MAX_PARALLEL_SUB_TURNS (4) slots. Four DAG
    // callers each sync-call a distinct level-1 callee (b1..b4); those four
    // callee turns occupy every sub-turn slot and, being sync callers
    // themselves, stay live while blocked on their own call. Each b then
    // sync-calls a distinct level-2 callee (d1..d4) — a legal depth-2 chain
    // the run must be able to launch. Since the four b-turns never release a
    // slot (they are waiting on d), the four d-turns can never acquire one:
    // the whole run wedges. Every d-turn should still start.
    const { service, claude, callBroker } = setup();
    const ids = [1, 2, 3, 4];
    const agent = (id: string) => ({
      id,
      kind: 'agent' as const,
      agent: 'claude' as const,
      approval: 'auto' as const,
    });
    const wf: Workflow = {
      name: 'nested-calls',
      nodes: [
        ...ids.map((i) => agent(`c${i}`)),
        ...ids.map((i) => agent(`b${i}`)),
        ...ids.map((i) => agent(`d${i}`)),
      ],
      edges: [
        ...ids.map((i) => ({
          from: `c${i}`,
          to: `b${i}`,
          kind: 'call' as const,
        })),
        ...ids.map((i) => ({
          from: `b${i}`,
          to: `d${i}`,
          kind: 'call' as const,
        })),
      ],
    };
    const run = await service.startRun({
      slug: 'nested',
      workflow: triggered(wf),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    // The four DAG callers are live; no callee has been invoked yet.
    expect(claude.starts).toHaveLength(4);

    // Each caller sync-calls its level-1 callee — this fills all four slots.
    for (const i of ids) {
      void callBroker.callAgent(run.id, `c${i}`, {
        agent: `b${i}`,
        message: `to-b${i}`,
      });
    }
    await drain();
    const afterB = claude.starts.map((t) => t.input.prompt);
    for (const i of ids) {
      expect(afterB).toContain(`to-b${i}`);
    }

    // Each level-1 callee sync-calls its own level-2 callee (depth 2, legal).
    for (const i of ids) {
      void callBroker.callAgent(run.id, `b${i}`, {
        agent: `d${i}`,
        message: `to-d${i}`,
      });
    }
    await drain();

    // Every level-2 callee turn must have launched.
    const prompts = claude.starts.map((t) => t.input.prompt);
    for (const i of ids) {
      expect(prompts).toContain(`to-d${i}`);
    }
  });

  it('caps concurrent depth-1 callee turns at MAX_PARALLEL_SUB_TURNS, then drains the queue', async () => {
    // Deleting the sub-turn slot acquire/release would let all 5 fan-out
    // callee turns spawn at once (up to 50 CLI agents in the worst case); this
    // pins that only 4 run concurrently and the 5th launches when one frees.
    const { service, claude, callBroker } = setup();
    const agent = (id: string) => ({
      id,
      kind: 'agent' as const,
      agent: 'claude' as const,
      approval: 'auto' as const,
    });
    const ids = [1, 2, 3, 4, 5];
    const wf: Workflow = {
      name: 'fanout',
      nodes: [agent('orch'), ...ids.map((i) => agent(`h${i}`))],
      edges: ids.map((i) => ({
        from: 'orch',
        to: `h${i}`,
        kind: 'call' as const,
      })),
    };
    const run = await service.startRun({
      slug: 'fanout',
      workflow: triggered(wf),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const orchTurn = claude.starts.length; // the caller turn already launched
    // Five async calls — all admitted by the broker, but the pool bounds how
    // many callee TURNS run at once.
    for (const i of ids) {
      void callBroker.callAgent(run.id, 'orch', {
        agent: `h${i}`,
        message: `call ${i}`,
        mode: 'async',
      });
    }
    await drain();
    const calleeTurns = () =>
      claude.starts.slice(orchTurn).map((t) => t.input.prompt);
    // Exactly four callee turns are live; the fifth waits for a slot.
    expect(calleeTurns()).toHaveLength(4);
    // Complete one callee → its slot frees → the queued fifth launches.
    const firstCallee = claude.starts.slice(orchTurn)[0]!;
    completeTurn(firstCallee, 'done');
    await drain();
    expect(calleeTurns()).toHaveLength(5);
    for (const i of ids) {
      expect(calleeTurns()).toContain(`call ${i}`);
    }
    // Drain the rest so the run can settle cleanly.
    for (const turn of claude.starts.slice(orchTurn)) {
      if (!turn.cancelled) {
        completeTurn(turn, 'done');
      }
    }
    completeTurn(claude.starts[orchTurn - 1]!, 'orch done');
    await drain();
  });

  it('surfaces "endpoint unavailable" when the server has no bound port', async () => {
    // port: null → mcpEndpointFor returns null → the self-check reports the
    // sync unavailable branch (distinct from the fetch-failure branch).
    const { service, claude, itemDao } = setup(null);
    await service.startRun({
      slug: 'c',
      workflow: triggered(CALL_WF),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const note = itemDao.items.find(
      (i) =>
        i.kind === 'system' &&
        JSON.parse(i.payload).message.includes('endpoint unavailable'),
    );
    expect(note).toBeDefined();
    completeTurn(claude.starts[0]!, 'done');
    await drain();
  });

  it('startRunBySlug looks the workflow up in the library and launches it (one-call controller seam)', async () => {
    const { service, claude, runDao, storeGet } = setup();
    storeGet.mockResolvedValue({ slug: 'lin', workflow: triggered(LINEAR) });

    const run = await service.startRunBySlug('lin', { cwd: dir, prompt: 'go' });

    expect(storeGet).toHaveBeenCalledWith('lin');
    await drain();
    expect(claude.starts.length).toBeGreaterThan(0);
    expect(runDao.runs.get(run.id)?.workflowId).toBe('lin');
  });

  it('startRunBySlug propagates a library miss without creating a run', async () => {
    const { service, runDao, storeGet } = setup();
    storeGet.mockRejectedValue(new Error('WORKFLOW_NOT_FOUND'));

    await expect(
      service.startRunBySlug('ghost', { cwd: dir, prompt: 'go' }),
    ).rejects.toThrow('WORKFLOW_NOT_FOUND');
    expect(runDao.runs.size).toBe(0);
  });

  it('settles a node failed (not a run-crashing throw) when adapter.start throws', async () => {
    // prepareTurn's config-file write can throw synchronously out of
    // adapter.start; drive()/startRun promise "never throws", so the node
    // must settle failed and the run must still roll up.
    const { service, claude, runDao, nodeDao } = setup();
    claude.throwNextStart = new Error('ENOSPC');
    await service.startRun({
      slug: 'lin',
      workflow: triggered({
        name: 'lin',
        nodes: [{ id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' }],
        edges: [],
      }),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    // The throw did not spawn a live turn, and the node/run settled failed.
    expect(claude.starts).toHaveLength(0);
    expect(nodeDao.row('run-0', 'a')?.status).toBe('failed');
    expect(runDao.runs.get('run-0')?.status).toBe('failed');
  });

  it('a callee whose start throws yields a CALL_FAILED envelope without wedging the run', async () => {
    const { service, claude, callBroker, runDao, itemDao } = setup();
    const run = await service.startRun({
      slug: 'c',
      workflow: triggered(CALL_WF),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    claude.throwNextStart = new Error('EACCES');
    const envelope = await callBroker.callAgent(run.id, 'orch', {
      agent: 'helper',
      message: 'go',
    });
    expect(envelope.status).toBe('error');
    if (envelope.status === 'error') {
      expect(envelope.error).toContain('turn start failed');
    }
    await drain();
    // persistTurnStart emitted a 'running' status item before the throw; the
    // catch must balance it with a call-attributed terminal one, or the
    // renderer's agents panel counts this callee as live for the whole run
    // (the sibling DAG-launch catch already does this).
    const helperStatuses = itemDao.items
      .filter((i) => i.kind === 'status')
      .map(
        (i) =>
          JSON.parse(i.payload) as {
            nodeId?: string;
            status?: string;
            callId?: string;
          },
      )
      .filter((p) => p.nodeId === 'helper');
    const running = helperStatuses.find((p) => p.status === 'running');
    const failed = helperStatuses.find((p) => p.status === 'failed');
    expect(running?.callId).toBeTruthy();
    expect(failed?.callId).toBe(running?.callId);
    // The caller turn still finishes and the run rolls up (not wedged).
    completeTurn(claude.starts[0]!, 'done');
    await drain();
    expect(runDao.runs.get(run.id)?.status).toBe('completed');
  });

  it('upserts callee node_state per call — the latest call wins', async () => {
    const { service, claude, callBroker, nodeDao } = setup();
    const run = await service.startRun({
      slug: 'c',
      workflow: triggered(CALL_WF),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    // First call → helper completes.
    const first = callBroker.callAgent(run.id, 'orch', {
      agent: 'helper',
      message: 'first',
    });
    await drain();
    completeTurn(claude.starts[1]!, 'ok-1');
    await first;
    await drain();
    expect(nodeDao.row(run.id, 'helper')?.status).toBe('completed');
    // Second call to the SAME callee → a fresh turn that fails; node_state
    // must reflect the LATEST call, not stick on the first completion.
    const second = callBroker.callAgent(run.id, 'orch', {
      agent: 'helper',
      message: 'second',
    });
    await drain();
    claude.starts[2]!.emit({ type: 'error', message: 'boom' });
    claude.starts[2]!.finish();
    await second;
    await drain();
    expect(nodeDao.row(run.id, 'helper')?.status).toBe('failed');
    completeTurn(claude.starts[0]!, 'done');
    await drain();
  });
});

describe('GraphExecutorService — Q&A bridge (M4)', () => {
  const CALL_WORKFLOW: Workflow = {
    name: 'qa',
    nodes: [
      { id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' },
      { id: 'callee', kind: 'agent', agent: 'claude', approval: 'auto' },
    ],
    edges: [{ from: 'a', to: 'callee', kind: 'call' as const }],
  };

  const QUESTION_INPUT = {
    questions: [
      {
        question: 'Which color?',
        header: 'Color',
        options: [{ label: 'Red' }, { label: 'Blue' }],
        multiSelect: false,
      },
    ],
  };

  it('parks a call-initiated question in the broker and delivers the answer as updatedInput.response — never a renderer card', async () => {
    const { service, claude, approvals, callBroker, itemDao } = setup();
    const run = await service.startRun({
      slug: 'qa',
      workflow: triggered(CALL_WORKFLOW),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const caller = claude.starts[0]!;
    // The caller is question-capable: ask-mode CLI + the question guidance in
    // its awareness block (headless claude has no AskUserQuestion under
    // --dangerously-skip-permissions).
    expect(caller.input.approvalMode).toBe('ask');
    expect(caller.input.callSurfacePrompt).toContain('answer_agent');

    const sync = callBroker.callAgent(run.id, 'a', {
      agent: 'callee',
      message: 'work',
    });
    await drain();
    expect(claude.starts).toHaveLength(2);
    const callee = claude.starts[1]!;
    // The 'auto' callee is spawned in ask mode too — the question channel.
    expect(callee.input.approvalMode).toBe('ask');

    callee.emit({
      type: 'approval_request',
      id: 'q-1',
      toolName: 'AskUserQuestion',
      input: QUESTION_INPUT,
      requiresUserInteraction: true,
    });
    await drain();
    const envelope = await sync;
    expect(envelope).toMatchObject({
      status: 'question',
      call_id: 'call-1',
      agent: 'callee',
      // Header-qualified: `options` is FLAT across questions, so the header is
      // what lets a caller tell which option belongs to which question.
      question: '[Color] Which color?',
      options: ['Red', 'Blue'],
    });
    // Bridged questions never become renderer approvals.
    expect(approvals.listByRun(run.id)).toEqual([]);
    expect(itemDao.items.some((i) => i.kind === 'approval_request')).toBe(
      false,
    );
    expect(itemDao.items.some((i) => i.kind === 'call_question')).toBe(true);

    const answered = callBroker.answerAgent(run.id, 'a', {
      call_id: 'call-1',
      answer: 'Blue',
    });
    expect(answered.status).toBe('ok');
    expect(callee.respondApproval).toHaveBeenCalledWith('q-1', true, {
      ...QUESTION_INPUT,
      response: 'Blue',
    });

    completeTurn(callee, 'blue it is');
    const final = await callBroker.awaitAgent(run.id, 'a', {
      call_id: 'call-1',
    });
    expect(final).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'callee', text: 'blue it is' },
    });
    completeTurn(caller, 'done');
    await drain();
  });

  it("auto-approves a call-initiated turn's plain permissions silently; an explicit 'ask' callee keeps the human card", async () => {
    const askCallee: Workflow = {
      ...CALL_WORKFLOW,
      nodes: [
        { id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' },
        { id: 'callee', kind: 'agent', agent: 'claude', approval: 'ask' },
      ],
    };
    const { service, claude, approvals, callBroker, itemDao } = setup();
    const run = await service.startRun({
      slug: 'qa-ask',
      workflow: triggered(askCallee),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const caller = claude.starts[0]!;
    // The CALLER is 'auto': its own plain permission is answered by the
    // daemon (unattended semantics), with no card and no transcript item.
    caller.emit({
      type: 'approval_request',
      id: 'p-caller',
      toolName: 'Bash',
      input: { command: 'ls' },
    });
    await drain();
    expect(caller.respondApproval).toHaveBeenCalledWith('p-caller', true, {
      command: 'ls',
    });
    expect(approvals.listByRun(run.id)).toEqual([]);
    expect(itemDao.items.some((i) => i.kind === 'approval_request')).toBe(
      false,
    );

    // The callee node is explicitly 'ask' — its plain permissions still go
    // to the human card exactly as before the bridge.
    void callBroker.callAgent(run.id, 'a', { agent: 'callee', message: 'm' });
    await drain();
    const callee = claude.starts[1]!;
    callee.emit({
      type: 'approval_request',
      id: 'p-callee',
      toolName: 'Write',
      input: { file_path: 'x' },
    });
    await drain();
    expect(callee.respondApproval).not.toHaveBeenCalled();
    expect(approvals.listByRun(run.id)).toHaveLength(1);
    expect(itemDao.items.some((i) => i.kind === 'approval_request')).toBe(true);
    completeTurn(callee, 'ok');
    completeTurn(caller, 'done');
    await drain();
  });

  it("a DAG caller's own question becomes an answerable card: the verdict answer rides updatedInput.response", async () => {
    const { service, claude, approvals, itemDao } = setup();
    const run = await service.startRun({
      slug: 'qa-escalate',
      workflow: triggered(CALL_WORKFLOW),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const caller = claude.starts[0]!;
    caller.emit({
      type: 'approval_request',
      id: 'q-esc',
      toolName: 'AskUserQuestion',
      input: QUESTION_INPUT,
      requiresUserInteraction: true,
    });
    await drain();
    // DAG-scheduled questions keep the card path (the escalation surface).
    expect(approvals.listByRun(run.id)).toHaveLength(1);
    const applied = approvals.resolve(run.id, 'q-esc', true, 'Blue');
    expect(applied).toBe(true);
    expect(caller.respondApproval).toHaveBeenCalledWith('q-esc', true, {
      ...QUESTION_INPUT,
      response: 'Blue',
    });
    await drain();
    const verdictItem = itemDao.items.find(
      (i) => i.kind === 'approval_verdict',
    );
    expect(JSON.parse(verdictItem!.payload)).toMatchObject({
      allow: true,
      answer: 'Blue',
    });
    completeTurn(caller, 'done');
    await drain();
  });

  it('leaves non-caller auto nodes on plain auto — no ask-mode override outside the call surface', async () => {
    const { service, claude } = setup();
    await service.startRun({
      slug: 'plain',
      workflow: triggered(LINEAR),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    expect(claude.starts[0]!.input.approvalMode).toBe('auto');
    completeTurn(claude.starts[0]!, 'done');
    await drain();
    completeTurn(claude.starts[1]!, 'done');
    await drain();
  });

  it('drains a parked question when its caller settles: the callee is cancelled and the call fails as QUESTION_ORPHANED', async () => {
    const { service, claude, callBroker, itemDao, runDao } = setup();
    const run = await service.startRun({
      slug: 'qa-orphan',
      workflow: triggered(CALL_WORKFLOW),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const caller = claude.starts[0]!;
    const sync = callBroker.callAgent(run.id, 'a', {
      agent: 'callee',
      message: 'work',
    });
    await drain();
    const callee = claude.starts[1]!;
    callee.emit({
      type: 'approval_request',
      id: 'q-1',
      toolName: 'AskUserQuestion',
      input: QUESTION_INPUT,
      requiresUserInteraction: true,
    });
    await drain();
    expect((await sync).status).toBe('question');

    // The caller ends without answering — nobody is left to answer_agent.
    completeTurn(caller, 'done without answering');
    await drain();
    expect(callee.cancelled).toBe(true);
    expect(
      JSON.parse(itemDao.items.find((i) => i.kind === 'call_answer')!.payload),
    ).toMatchObject({ outcome: 'orphaned' });
    const callResult = itemDao.items.find((i) => i.kind === 'call_result');
    const callResultPayload = JSON.parse(callResult!.payload) as {
      status: string;
      error?: string;
    };
    expect(callResultPayload.status).toBe('error');
    expect(callResultPayload.error).toContain('QUESTION_ORPHANED');
    // The run still settles — an orphaned question never wedges it.
    expect(runDao.runs.get(run.id)?.status).toBe('completed');
  });

  it('keeps cursor callees on their own approval mode — no ask override, no question channel', async () => {
    const mixed: Workflow = {
      name: 'mixed',
      nodes: [
        { id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' },
        {
          id: 'callee',
          kind: 'agent',
          agent: 'cursor-agent',
          approval: 'auto',
        },
      ],
      edges: [{ from: 'a', to: 'callee', kind: 'call' as const }],
    };
    const { service, claude, cursor, callBroker } = setup();
    const run = await service.startRun({
      slug: 'mixed',
      workflow: triggered(mixed),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    void callBroker.callAgent(run.id, 'a', { agent: 'callee', message: 'm' });
    await drain();
    expect(cursor.starts).toHaveLength(1);
    expect(cursor.starts[0]!.input.approvalMode).toBe('auto');
    completeTurn(cursor.starts[0]!, 'ok');
    completeTurn(claude.starts[0]!, 'done');
    await drain();
  });
});

describe('GraphExecutorService — Q&A bridge guards (round 2)', () => {
  const CALL_WORKFLOW: Workflow = {
    name: 'qa2',
    nodes: [
      { id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' },
      { id: 'callee', kind: 'agent', agent: 'claude', approval: 'auto' },
    ],
    edges: [{ from: 'a', to: 'callee', kind: 'call' as const }],
  };
  const QUESTION_INPUT = {
    questions: [
      {
        question: 'Which color?',
        options: [{ label: 'Red' }, { label: 'Blue' }],
      },
    ],
  };

  async function parkOne(slug: string): Promise<{
    ctx: ReturnType<typeof setup>;
    run: { id: string };
    sync: Promise<unknown>;
    caller: FakeTurn;
    callee: FakeTurn;
  }> {
    const ctx = setup();
    const run = await ctx.service.startRun({
      slug,
      workflow: triggered(CALL_WORKFLOW),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const caller = ctx.claude.starts[0]!;
    const sync = ctx.callBroker.callAgent(run.id, 'a', {
      agent: 'callee',
      message: 'work',
    });
    await drain();
    const callee = ctx.claude.starts[1]!;
    callee.emit({
      type: 'approval_request',
      id: 'q-1',
      toolName: 'AskUserQuestion',
      input: QUESTION_INPUT,
      requiresUserInteraction: true,
    });
    await drain();
    return { ctx, run, sync, caller, callee };
  }

  it('denies a SECOND question raised while the first is parked — the callee must not hang unanswerable', async () => {
    const { ctx, run, sync, caller, callee } = await parkOne('qa2-second');
    expect(((await sync) as { status: string }).status).toBe('question');
    callee.emit({
      type: 'approval_request',
      id: 'q-2',
      toolName: 'AskUserQuestion',
      input: QUESTION_INPUT,
      requiresUserInteraction: true,
    });
    await drain();
    expect(callee.respondApproval).toHaveBeenCalledWith('q-2', false);
    ctx.callBroker.answerAgent(run.id, 'a', {
      call_id: 'call-1',
      answer: 'Blue',
    });
    completeTurn(callee, 'done');
    completeTurn(caller, 'done');
    await drain();
  });

  it('denies a question its adapter projects nothing out of — a blank question is never parked on the caller', async () => {
    const ctx = setup();
    // The adapter answers the BASE default (null): the payload carries no
    // question this CLI can project. Parking it anyway would hand the caller
    // an empty question it can only answer blind.
    ctx.claude.projectsNoQuestion = true;
    const run = await ctx.service.startRun({
      slug: 'qa2-unprojectable',
      workflow: triggered(CALL_WORKFLOW),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const caller = ctx.claude.starts[0]!;
    const sync = ctx.callBroker.callAgent(run.id, 'a', {
      agent: 'callee',
      message: 'work',
    });
    await drain();
    const callee = ctx.claude.starts[1]!;
    callee.emit({
      type: 'approval_request',
      id: 'q-1',
      toolName: 'AskUserQuestion',
      input: QUESTION_INPUT,
      requiresUserInteraction: true,
    });
    await drain();
    expect(callee.respondApproval).toHaveBeenCalledWith('q-1', false);
    expect(ctx.itemDao.items.some((i) => i.kind === 'call_question')).toBe(
      false,
    );
    completeTurn(callee, 'done');
    // The call ran to completion instead of stalling on a question nobody
    // could answer.
    expect(((await sync) as { status: string }).status).toBe('ok');
    completeTurn(caller, 'done');
    await drain();
  });

  it('run cancel reaches a parked callee: the turn dies with the run and no timeout ever fires', async () => {
    const { ctx, run, sync, callee } = await parkOne('qa2-cancel');
    expect(((await sync) as { status: string }).status).toBe('question');
    await ctx.service.cancel(run.id);
    await drain();
    expect(callee.cancelled).toBe(true);
    expect(ctx.runDao.runs.get(run.id)?.status).toBe('cancelled');
    // The cancelled caller's settle drain orphans the parked question — the
    // resolution row is 'orphaned', NEVER a later 'timeout' from a leaked
    // TTL timer, and the call settles as an error.
    const callResult = ctx.itemDao.items.find((i) => i.kind === 'call_result');
    expect(JSON.parse(callResult!.payload)).toMatchObject({ status: 'error' });
    const outcomes = ctx.itemDao.items
      .filter((i) => i.kind === 'call_answer')
      .map((i) => (JSON.parse(i.payload) as { outcome: string }).outcome);
    expect(outcomes).toEqual(['orphaned']);
  });

  it("a plain tool's approval NEVER folds a verdict answer — original input delivered, nothing recorded", async () => {
    // The negative half of the fold gate: a crafted verdict carrying an
    // answer for a NON-question tool must neither mutate the tool input nor
    // be recorded in the transcript.
    const askCaller: Workflow = {
      ...CALL_WORKFLOW,
      nodes: [
        { id: 'a', kind: 'agent', agent: 'claude', approval: 'ask' },
        { id: 'callee', kind: 'agent', agent: 'claude', approval: 'auto' },
      ],
    };
    const ctx = setup();
    const run = await ctx.service.startRun({
      slug: 'qa2-no-fold',
      workflow: triggered(askCaller),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const caller = ctx.claude.starts[0]!;
    caller.emit({
      type: 'approval_request',
      id: 'p-1',
      toolName: 'Write',
      input: { file_path: 'x' },
    });
    await drain();
    expect(ctx.approvals.resolve(run.id, 'p-1', true, 'sneaky')).toBe(true);
    expect(caller.respondApproval).toHaveBeenCalledWith('p-1', true, {
      file_path: 'x',
    });
    await drain();
    const verdictItem = ctx.itemDao.items.find(
      (i) => i.kind === 'approval_verdict',
    );
    expect(JSON.parse(verdictItem!.payload)).not.toHaveProperty('answer');
    completeTurn(caller, 'done');
    await drain();
  });

  it('parks an AskUserQuestion WITHOUT the interaction flag — the bridge keys on the tool NAME alone', async () => {
    // The name-only keying is the drift hardening: if a future CLI drops the
    // flag on a real question, the bridge must still park it for the caller
    // (a name-AND-flag regression would divert it to the card path where no
    // caller can ever answer).
    const ctx = setup();
    const run = await ctx.service.startRun({
      slug: 'qa2-no-flag',
      workflow: triggered(CALL_WORKFLOW),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const caller = ctx.claude.starts[0]!;
    const sync = ctx.callBroker.callAgent(run.id, 'a', {
      agent: 'callee',
      message: 'work',
    });
    await drain();
    const callee = ctx.claude.starts[1]!;
    callee.emit({
      type: 'approval_request',
      id: 'q-nf',
      toolName: 'AskUserQuestion',
      input: QUESTION_INPUT,
    });
    await drain();
    expect(((await sync) as { status: string }).status).toBe('question');
    expect(ctx.itemDao.items.some((i) => i.kind === 'call_question')).toBe(
      true,
    );
    ctx.callBroker.answerAgent(run.id, 'a', {
      call_id: 'call-1',
      answer: 'Blue',
    });
    completeTurn(callee, 'done');
    completeTurn(caller, 'done');
    await drain();
  });

  it('keeps a flagged request under an UNKNOWN tool name on the approval path — never bridged to the caller', async () => {
    const ctx = setup();
    const run = await ctx.service.startRun({
      slug: 'qa2-unknown-tool',
      workflow: triggered(CALL_WORKFLOW),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const caller = ctx.claude.starts[0]!;
    void ctx.callBroker.callAgent(run.id, 'a', {
      agent: 'callee',
      message: 'work',
    });
    await drain();
    const callee = ctx.claude.starts[1]!;
    // A future CLI could flag some OTHER interactive tool — bridging it to
    // the caller would let an agent answer what may be a permission-like
    // gate, so it must stay on the (auto/card) approval path.
    callee.emit({
      type: 'approval_request',
      id: 'x-1',
      toolName: 'FutureInteractiveTool',
      input: { anything: true },
      requiresUserInteraction: true,
    });
    await drain();
    expect(callee.respondApproval).toHaveBeenCalledWith('x-1', true, {
      anything: true,
    });
    expect(ctx.itemDao.items.some((i) => i.kind === 'call_question')).toBe(
      false,
    );
    completeTurn(callee, 'done');
    completeTurn(caller, 'done');
    await drain();
  });
});

describe('GraphExecutorService — widened approval modes (parity M1)', () => {
  const ACCEPT_EDITS_NODE: Workflow = {
    name: 'accept-edits',
    nodes: [
      { id: 'a', kind: 'agent', agent: 'claude', approval: 'acceptEdits' },
    ],
    edges: [],
  };
  const ACCEPT_EDITS_CALLER: Workflow = {
    name: 'accept-edits-caller',
    nodes: [
      { id: 'a', kind: 'agent', agent: 'claude', approval: 'acceptEdits' },
      { id: 'callee', kind: 'agent', agent: 'claude', approval: 'auto' },
    ],
    edges: [{ from: 'a', to: 'callee', kind: 'call' as const }],
  };

  it("spawns a plain acceptEdits node with approvalMode 'acceptEdits' — not ask, not auto", async () => {
    const { service, claude } = setup();
    await service.startRun({
      slug: 'ae',
      workflow: triggered(ACCEPT_EDITS_NODE),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    expect(claude.starts[0]!.input.approvalMode).toBe('acceptEdits');
    completeTurn(claude.starts[0]!, 'done');
    await drain();
  });

  it('an acceptEdits CALLER keeps its mode and its plain permissions stay on the human card — the daemon auto-approve is auto-only', async () => {
    const { service, claude, approvals, itemDao } = setup();
    const run = await service.startRun({
      slug: 'ae-caller',
      workflow: triggered(ACCEPT_EDITS_CALLER),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const caller = claude.starts[0]!;
    // questionCapable does NOT force ask here: acceptEdits already carries
    // the stdio dialogue the question channel needs.
    expect(caller.input.approvalMode).toBe('acceptEdits');
    // A plain permission on the acceptEdits caller must NOT be silently
    // auto-approved (that path is reserved for approval 'auto' nodes) —
    // this assertion fails if the :877 guard reverts to `!== 'ask'`.
    caller.emit({
      type: 'approval_request',
      id: 'p-ae',
      toolName: 'Bash',
      input: { command: 'rm -rf /tmp/x' },
    });
    await drain();
    expect(caller.respondApproval).not.toHaveBeenCalled();
    expect(approvals.listByRun(run.id)).toHaveLength(1);
    expect(itemDao.items.some((i) => i.kind === 'approval_request')).toBe(true);
    completeTurn(caller, 'done');
    await drain();
  });

  it("degrades a claude acceptEdits node to 'ask' with a visible system item when the probe verdict is FAIL", async () => {
    const { service, claude, itemDao } = setup(4870, {
      claudeModes: {
        acceptEdits: 'fail',
        plan: 'fail',
        version: 'claude-old',
        probedAt: 0,
        reason:
          'installed claude does not support --permission-mode acceptEdits',
      },
    });
    await service.startRun({
      slug: 'ae-degrade',
      workflow: triggered(ACCEPT_EDITS_NODE),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    expect(claude.starts[0]!.input.approvalMode).toBe('ask');
    const system = itemDao.items.find(
      (i) =>
        i.kind === 'system' &&
        i.payload.includes('does not support acceptEdits'),
    );
    expect(system).toBeDefined();
    completeTurn(claude.starts[0]!, 'done');
    await drain();
  });

  it("keeps a claude plan node on 'plan' even when the probe FAILED it", async () => {
    // The graph half of the policy the adapter owns: acceptEdits degrades,
    // plan does not — turning a no-execute mode into an executing 'ask' would
    // invert what the author selected. Same verdict as the acceptEdits test
    // above, opposite outcome, which is what proves the adapter is deciding
    // rather than the executor pattern-matching a probe field.
    const { service, claude, itemDao } = setup(4880, {
      claudeModes: {
        acceptEdits: 'fail',
        plan: 'fail',
        version: 'claude-old',
        probedAt: 0,
        reason: 'installed claude rejects both probed modes',
      },
    });
    await service.startRun({
      slug: 'plan-no-degrade',
      workflow: triggered({
        name: 'plan-no-degrade',
        nodes: [{ id: 'p', kind: 'agent', agent: 'claude', approval: 'plan' }],
        edges: [],
      }),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    expect(claude.starts[0]!.input.approvalMode).toBe('plan');
    expect(
      itemDao.items.some(
        (i) => i.kind === 'system' && i.payload.includes('degrade'),
      ),
    ).toBe(false);
    completeTurn(claude.starts[0]!, 'done');
    await drain();
  });

  it('waits on the mode probe only for a workflow that asks for a probed mode', async () => {
    // `hasProbedApprovalMode` asks each node's ADAPTER which of its modes are
    // empirical, so an all-auto graph never pays for a probe turn. Without the
    // predicate every run would block on it.
    const auto = setup(4881);
    await auto.service.startRun({
      slug: 'auto-only',
      workflow: triggered({
        name: 'auto-only',
        nodes: [{ id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' }],
        edges: [],
      }),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    expect(auto.claudeEnsureVerdict).not.toHaveBeenCalled();
    completeTurn(auto.claude.starts[0]!, 'done');
    await drain();

    const probed = setup(4882);
    await probed.service.startRun({
      slug: 'accept-edits',
      workflow: triggered(ACCEPT_EDITS_NODE),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    expect(probed.claudeEnsureVerdict).toHaveBeenCalledTimes(1);
    completeTurn(probed.claude.starts[0]!, 'done');
    await drain();
  });
});

describe('GraphExecutorService — deleting a workflow run', () => {
  const ONE_NODE: Workflow = {
    name: 'one',
    nodes: [{ id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' }],
    edges: [],
  };

  /** An acceptEdits node is what makes a walk wait on the claude mode probe. */
  const PROBED_NODE: Workflow = {
    name: 'ae',
    nodes: [
      { id: 'a', kind: 'agent', agent: 'claude', approval: 'acceptEdits' },
    ],
    edges: [],
  };

  /**
   * Hold the next walk inside its capability probe until the returned fn runs
   * — the claim→register window, where the run is claimed but has no handle a
   * delete could wait on.
   */
  function stallProbe(ctx: ReturnType<typeof setup>): () => void {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ctx.claudeEnsureVerdict.mockImplementation(async () => {
      await gate;
      return {
        acceptEdits: 'pass',
        plan: 'pass',
        version: 'claude-test',
        probedAt: 0,
        reason: null,
      };
    });
    return release;
  }

  /** A settled workflow run with a transcript, ready to delete. */
  async function finishedRun(ctx: ReturnType<typeof setup>) {
    const run = await ctx.service.startRun({
      slug: 'one',
      workflow: triggered(ONE_NODE),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    completeTurn(ctx.claude.starts[0]!, 'done');
    await drain();
    return run;
  }

  it('removes the run, its items and its node states', async () => {
    // The reported defect: the chats sidebar lists workflow runs beside chats,
    // but only the chat rows could be deleted — the chat route refuses a
    // workflow run and nothing else offered a delete, so those rows were
    // permanent.
    const ctx = await setup();
    const run = await finishedRun(ctx);
    expect(ctx.itemDao.items.length).toBeGreaterThan(0);
    expect(ctx.nodeDao.rows.size).toBeGreaterThan(0);

    expect(await ctx.service.deleteRun(run.id)).toEqual({ deleted: true });

    expect(ctx.runDao.runs.get(run.id)).toBeUndefined();
    expect(ctx.itemDao.items).toEqual([]);
    expect(ctx.nodeDao.rows.size).toBe(0);
  });

  it('deletes with the soft-delete filter DISABLED, in all three tables', async () => {
    const ctx = await setup();
    const run = await finishedRun(ctx);
    await ctx.service.deleteRun(run.id);

    // The filter-disabling variant, never the plain `hardDelete` that hydrates
    // through `deletedAt: null` and would silently skip a soft-deleted row.
    expect(ctx.runDao.hardDeleted).toEqual([{ id: run.id }]);
    expect(ctx.itemDao.hardDeleted).toEqual([{ runId: run.id }]);
    expect(ctx.nodeDao.hardDeleted).toEqual([{ runId: run.id }]);
  });

  it('drops the run’s call surface, its tokens, its attachments, and announces it', async () => {
    // None of these cascade from the `runs` row: the broker and the token
    // registry are in memory, attachments are files, and the PTY mirror lives
    // in a module above this one and learns only by subscription.
    const ctx = await setup();
    const run = await ctx.service.startRun({
      slug: 'calls',
      workflow: triggered({
        name: 'calls',
        nodes: [
          { id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' },
          { id: 'callee', kind: 'agent', agent: 'claude', approval: 'auto' },
        ],
        edges: [{ from: 'a', to: 'callee', kind: 'call' as const }],
      }),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    expect(ctx.callBroker.hasRun(run.id)).toBe(true);
    expect(ctx.callTokens.get(run.id, 'a')).not.toBeNull();

    await ctx.service.deleteRun(run.id);

    expect(ctx.callBroker.hasRun(run.id)).toBe(false);
    expect(ctx.callTokens.get(run.id, 'a')).toBeNull();
    expect(ctx.removedAttachmentRuns).toEqual([run.id]);
    expect(ctx.deletedRuns).toEqual([run.id]);
  });

  it('stops a LIVE run and waits for its final writes before destroying the rows', async () => {
    // Cancel only SIGNALS: the DAG keeps writing (each node's terminal item,
    // the run's status roll-up and its `turn_complete`) until the aggregate
    // handle settles. A delete that merely cancelled and proceeded would leave
    // those items behind for a run whose row is gone — `Item.runId` has no FK,
    // so the inserts SUCCEED and nothing can ever read or delete them again.
    const ctx = await setup();
    const run = await ctx.service.startRun({
      slug: 'one',
      workflow: triggered(ONE_NODE),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    expect(ctx.claude.starts).toHaveLength(1);

    await ctx.service.deleteRun(run.id);

    expect(ctx.claude.starts[0]!.cancelled).toBe(true);
    expect(ctx.runDao.runs.get(run.id)).toBeUndefined();
    expect(ctx.itemDao.items).toEqual([]);
    // And nothing lands afterwards either.
    await drain();
    expect(ctx.itemDao.items).toEqual([]);
    expect(ctx.registry.has(run.id)).toBe(false);
  });

  it('a walk still crossing the claim→register window abandons itself instead of outliving the delete', async () => {
    // `startRun` claims the run, then `drive` AWAITS the capability probes
    // before `driveResolved` registers the aggregate handle. A delete landing
    // in that gap has no handle to wait on, so the walk must notice the delete
    // itself — otherwise it registers afterwards and writes a whole run's
    // items for a run that no longer exists.
    const ctx = setup();
    const releaseProbe = stallProbe(ctx);
    const run = await ctx.service.startRun({
      slug: 'ae',
      workflow: triggered(PROBED_NODE),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    // Claimed and probing — nothing has spawned yet.
    expect(ctx.claude.starts).toHaveLength(0);

    await ctx.service.deleteRun(run.id);
    releaseProbe();
    await drain();

    expect(ctx.claude.starts).toHaveLength(0);
    expect(ctx.itemDao.items).toEqual([]);
    expect(ctx.runDao.runs.get(run.id)).toBeUndefined();
    // The claim was released, so the id is not wedged as permanently busy.
    expect(ctx.registry.has(run.id)).toBe(false);
  });

  it('a walk resuming while a delete is IN FLIGHT abandons itself — the row is still there', async () => {
    // The other arm of the same guard. Here the delete has cancelled the run
    // and passed its own checks but has NOT yet purged the run row, so the
    // walk's re-read finds it alive; only the `deleting` Set knows it is
    // doomed. Without that arm the walk drives on and its items are orphaned
    // by the purge a moment later.
    const ctx = setup();
    const releaseProbe = stallProbe(ctx);
    const run = await ctx.service.startRun({
      slug: 'ae',
      workflow: triggered(PROBED_NODE),
      cwd: dir,
      prompt: 'go',
    });
    await drain();

    let releasePurge = (): void => {};
    ctx.runDao.purgeGate = new Promise<void>((resolve) => {
      releasePurge = resolve;
    });
    const deleting = ctx.service.deleteRun(run.id);
    await drain();
    // Mid-delete: the run row still exists, so only the Set can catch this.
    expect(ctx.runDao.runs.get(run.id)).toBeDefined();

    releaseProbe();
    await drain();
    releasePurge();
    await deleting;

    expect(ctx.claude.starts).toHaveLength(0);
    expect(ctx.itemDao.items).toEqual([]);
    expect(ctx.runDao.runs.get(run.id)).toBeUndefined();
    expect(ctx.registry.has(run.id)).toBe(false);
  });

  it('refuses to delete a CHAT run through the workflow route', async () => {
    // The chat service owns its own teardown (attachments, partial streams);
    // deleting through here would skip it.
    const { service, runDao } = setup();
    const chatRun = await runDao.create({
      workflowId: null,
      status: 'completed',
    });
    await expect(service.deleteRun(chatRun.id)).rejects.toThrow();
    expect(runDao.runs.get(chatRun.id)).toBeDefined();
  });

  it('404s on a run that does not exist', async () => {
    const { service } = setup();
    await expect(service.deleteRun('nope')).rejects.toThrow();
  });
});

describe('GraphExecutorService — the MCP switch reaches a node turn', () => {
  it('hands each node the servers switched off for ITS agent in the run folder', async () => {
    // The graph half of the seam the whole feature rests on. Delete the store
    // read in the executor and every switch stops applying to graph runs,
    // silently — the panel keeps showing them off.
    const settingsDir = realpathSync(
      mkdtempSync(join(tmpdir(), 'exec-mcp-seam-')),
    );
    const file = join(settingsDir, 'mcp-settings.json');
    const store = new McpSettingsStore({ file });
    await store.setDisabled(AgentKind.Claude, dir, 'sentry', true);
    await store.setDisabled(AgentKind.CursorAgent, dir, 'linear', true);

    const { service, claude, cursor } = setup(4870, { mcpSettingsFile: file });
    await service.startRun({
      slug: 'two',
      workflow: triggered({
        name: 'two',
        nodes: [
          { id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' },
          { id: 'b', kind: 'agent', agent: 'cursor-agent', approval: 'auto' },
        ],
        edges: [],
      }),
      cwd: dir,
      prompt: 'go',
    });
    await drain();

    // Each node gets its OWN agent's switches, never the other's — one folder
    // is routinely driven by both CLIs and their server sets are unrelated.
    expect(claude.starts[0]?.input.disabledMcpServers).toEqual(['sentry']);
    expect(cursor.starts[0]?.input.disabledMcpServers).toEqual(['linear']);

    rmSync(settingsDir, { recursive: true, force: true });
  });
});

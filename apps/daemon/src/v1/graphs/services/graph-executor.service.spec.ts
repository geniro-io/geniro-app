import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import type { BadRequestException } from '@packages/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CallTokenRegistry } from '../../../auth/call-token.registry';
import type {
  AgentEvent,
  AgentTurnInput,
} from '../../agents/adapters/adapter.types';
import type { ClaudeAdapter } from '../../agents/adapters/claude/claude.adapter';
import type { CursorAdapter } from '../../agents/adapters/cursor/cursor.adapter';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { NodeStateDao } from '../../agents/dao/node-state.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ApprovalRegistry } from '../../agents/services/approval-registry';
import type { CursorMcpMergeService } from '../../agents/services/cursor-mcp-merge.service';
import { ProcessRegistry } from '../../agents/services/process-registry';
import type { Item } from '../../runs/entity/item.entity';
import type { NodeState } from '../../runs/entity/node-state.entity';
import type { Run } from '../../runs/entity/run.entity';
import type { CursorCallsCapability, Workflow } from '../graphs.types';
import { CallBroker } from './call-broker.service';
import type { CursorProbeService } from './cursor-probe.service';
import { GraphExecutorService } from './graph-executor.service';

// ── In-memory fakes (mirroring chat.service.spec's harness) ──────────────────
class FakeRunDao {
  readonly runs = new Map<string, Run>();
  private n = 0;
  async getById(id: string): Promise<Run | null> {
    return this.runs.get(id) ?? null;
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
  async create(data: Partial<Item>): Promise<Item> {
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
  private key(runId: string, nodeId: string): string {
    return `${runId}:${nodeId}`;
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
  constructor(readonly kind: 'claude' | 'cursor-agent') {}
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
    mergeOk?: boolean;
    gitTracked?: boolean;
    mergeImpl?: () => Promise<unknown>;
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
  mergeAcquire: ReturnType<typeof vi.fn>;
  mergeReleases: ReturnType<typeof vi.fn>[];
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
  const cursorProbe = {
    capability: () => cursorCalls,
    ensureVerdict,
    isProbeRun: () => false,
    noteEchoCall: () => {},
  } as unknown as CursorProbeService;
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
  const cursorMerge = {
    acquire: mergeAcquire,
    reconcileStranded: () => 0,
  } as unknown as CursorMcpMergeService;
  const em = { fork: () => ({ clear: () => {} }) } as unknown as EntityManager;
  const service = new GraphExecutorService(
    em,
    runDao as unknown as RunDao,
    itemDao as unknown as ItemDao,
    nodeDao as unknown as NodeStateDao,
    new AgentEventBus(),
    registry,
    approvals,
    claude as unknown as ClaudeAdapter,
    cursor as unknown as CursorAdapter,
    callTokens,
    callBroker,
    cursorProbe,
    cursorMerge,
    {
      token: 'launch-token',
      version: '0.0.0-test',
      startedAt: 0,
      port: runtimePort,
    },
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
    mergeAcquire,
    mergeReleases,
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

  it('continues the DAG walk when a node settle write throws (run still finalizes)', async () => {
    const { service, claude, runDao, nodeDao, registry } = setup();
    // The bookkeeping write for node a's completion blows up (disk full).
    const original = nodeDao.setStatus.bind(nodeDao);
    let failedOnce = false;
    nodeDao.setStatus = async (runId, nodeId, patch) => {
      if (!failedOnce && patch.status === 'completed') {
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

    // Node b still launched despite a's failed status write…
    expect(claude.starts).toHaveLength(2);
    completeTurn(claude.starts[1]!, 'B out');
    await drain();

    // …and the run finalizes instead of leaking its registry claim.
    expect(runDao.runs.get(run.id)?.status).toBe('completed');
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

  it('notes the ask→auto degrade for cursor-agent nodes', async () => {
    const { service, cursor, itemDao } = setup();
    await service.startRun({
      slug: 'c',
      workflow: triggered({
        name: 'c',
        nodes: [
          { id: 'only', kind: 'agent', agent: 'cursor-agent', approval: 'ask' },
        ],
        edges: [],
      }),
      cwd: dir,
      prompt: 'task',
    });
    await drain();
    const note = itemDao.items.find((i) => i.kind === 'system');
    expect(JSON.parse(note!.payload).message).toContain('cursor-agent');
    completeTurn(cursor.starts[0]!, 'done');
    await drain();
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
        role: 'You help.',
      },
    ],
    edges: [{ from: 'orch', to: 'helper', kind: 'call' as const }],
  };

  it('grants the claude caller its MCP endpoint + awareness block; the callee turn stays bare', async () => {
    const { service, claude, callTokens, callBroker } = setup();
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
    // Awareness: role first, then the May-call block naming id + role.
    expect(caller.input.systemPrompt).toContain('You orchestrate.');
    expect(caller.input.systemPrompt).toContain('May call');
    expect(caller.input.systemPrompt).toContain('Helper (agent id: helper)');

    const envelope = callBroker.callAgent(run.id, 'orch', {
      agent: 'helper',
      message: 'help me',
    });
    await drain();
    const callee = claude.starts[1]!;
    // The callee is NOT a caller: bare role, no endpoint, fresh prompt.
    expect(callee.input.prompt).toBe('help me');
    expect(callee.input.systemPrompt).toBe('You help.');
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
  });

  const CURSOR_CALLER_WF: Workflow = {
    ...CALL_WF,
    nodes: [
      { ...CALL_WF.nodes[0]!, agent: 'cursor-agent' as const },
      CALL_WF.nodes[1]!,
    ],
  };

  it('a probe-failed cursor caller is shut out of EVERY gate — no endpoint, no token, bare role — with a visible degrade item', async () => {
    const { service, cursor, callTokens, itemDao, mergeAcquire } = setup(4870, {
      cursorCalls: {
        status: 'fail',
        version: 'v1',
        probedAt: 1,
        reason: 'no headless MCP trust',
      },
    });
    const run = await service.startRun({
      slug: 'c',
      workflow: triggered(CURSOR_CALLER_WF),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const caller = cursor.starts[0]!;
    expect(caller.input.mcpEndpoint ?? null).toBeNull();
    expect(caller.input.systemPrompt).toBe('You orchestrate.');
    expect(callTokens.get(run.id, 'orch')).toBeNull();
    expect(mergeAcquire).not.toHaveBeenCalled();
    const degrade = itemDao.items.find(
      (i) =>
        i.kind === 'system' &&
        JSON.parse(i.payload).message.includes('agent calls disabled'),
    );
    expect(JSON.parse(degrade!.payload).message).toContain(
      'no headless MCP trust',
    );
    completeTurn(caller, 'done');
    await drain();
  });

  it('a probe-passed cursor caller is admitted through every gate: token, merged endpoint, awareness block; the merge is released on settle', async () => {
    const { service, cursor, callTokens, mergeAcquire, mergeReleases } = setup(
      4870,
      {
        cursorCalls: {
          status: 'pass',
          version: 'v1',
          probedAt: 1,
          reason: null,
        },
      },
    );
    const run = await service.startRun({
      slug: 'c',
      workflow: triggered(CURSOR_CALLER_WF),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const caller = cursor.starts[0]!;
    expect(caller.input.mcpEndpoint?.url).toBe(
      `http://127.0.0.1:4870/v1/mcp/${encodeURIComponent(run.id)}/orch`,
    );
    expect(caller.input.mcpEndpoint?.token).toBe(
      callTokens.get(run.id, 'orch'),
    );
    expect(caller.input.systemPrompt).toContain('May call');
    // The merge wrapped the turn: acquired with this cwd + endpoint…
    expect(mergeAcquire).toHaveBeenCalledWith(dir, caller.input.mcpEndpoint);
    expect(mergeReleases[0]).not.toHaveBeenCalled();
    completeTurn(caller, 'done');
    await drain();
    // …and released exactly once when the turn settled.
    expect(mergeReleases[0]).toHaveBeenCalledTimes(1);
  });

  it('a refused merge DEGRADES the cursor caller turn — the CLI spawns without the endpoint and a system item names the reason', async () => {
    const { service, cursor, itemDao, runDao } = setup(4870, {
      cursorCalls: { status: 'pass', version: 'v1', probedAt: 1, reason: null },
      mergeOk: false,
    });
    const run = await service.startRun({
      slug: 'c',
      workflow: triggered(CURSOR_CALLER_WF),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const caller = cursor.starts[0]!;
    expect(caller.input.mcpEndpoint ?? null).toBeNull();
    const degrade = itemDao.items.find(
      (i) =>
        i.kind === 'system' &&
        JSON.parse(i.payload).message.includes('merge refused (test)'),
    );
    expect(degrade).toBeDefined();
    completeTurn(caller, 'done');
    await drain();
    // The degrade never fails the run — the turn ran, just without call tools.
    expect(runDao.runs.get(run.id)?.status).toBe('completed');
  });

  const PASS_VERDICT: CursorCallsCapability = {
    status: 'pass',
    version: 'v1',
    probedAt: 1,
    reason: null,
  };

  it('a run cancelled while the merge lock is pending spawns NO cursor CLI, frees the merge, and persists no degrade item', async () => {
    let resolveAcquire!: (value: unknown) => void;
    const { service, cursor, runDao, nodeDao, itemDao } = setup(4870, {
      cursorCalls: PASS_VERDICT,
      mergeImpl: () =>
        new Promise((resolve) => {
          resolveAcquire = resolve;
        }),
    });
    const run = await service.startRun({
      slug: 'c',
      workflow: triggered(CURSOR_CALLER_WF),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    await service.cancel(run.id);
    await drain();
    const release = vi.fn();
    resolveAcquire({ ok: true, gitTracked: false, release });
    await drain();

    expect(cursor.starts).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
    expect(nodeDao.row(run.id, 'orch')?.status).toBe('cancelled');
    expect(runDao.runs.get(run.id)?.status).toBe('cancelled');
    const degrade = itemDao.items.some(
      (i) =>
        i.kind === 'system' &&
        JSON.parse(i.payload).message.includes('agent calls disabled'),
    );
    expect(degrade).toBe(false);
  });

  it('a REJECTING merge acquire settles the node as failed instead of wedging the run', async () => {
    const { service, cursor, runDao, nodeDao, itemDao } = setup(4870, {
      cursorCalls: PASS_VERDICT,
      mergeImpl: () => Promise.reject(new Error('EROFS boom')),
    });
    const run = await service.startRun({
      slug: 'c',
      workflow: triggered(CURSOR_CALLER_WF),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    expect(cursor.starts).toHaveLength(0);
    expect(nodeDao.row(run.id, 'orch')?.status).toBe('failed');
    expect(runDao.runs.get(run.id)?.status).toBe('failed');
    const errorItem = itemDao.items.find((i) => i.kind === 'error');
    expect(JSON.parse(errorItem!.payload).message).toContain(
      'turn start failed: EROFS boom',
    );
  });

  it('a git-tracked .cursor/mcp.json surfaces the do-not-commit warning item', async () => {
    const { service, cursor, itemDao } = setup(4870, {
      cursorCalls: PASS_VERDICT,
      gitTracked: true,
    });
    await service.startRun({
      slug: 'c',
      workflow: triggered(CURSOR_CALLER_WF),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const warning = itemDao.items.find(
      (i) =>
        i.kind === 'system' &&
        JSON.parse(i.payload).message.includes('git-tracked'),
    );
    expect(warning).toBeDefined();
    completeTurn(cursor.starts[0]!, 'done');
    await drain();
  });

  it('only cursor-caller workflows wait on the probe verdict at run start', async () => {
    const claudeOnly = setup();
    await claudeOnly.service.startRun({
      slug: 'c',
      workflow: triggered(CALL_WF),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    expect(claudeOnly.ensureVerdict).not.toHaveBeenCalled();
    completeTurn(claudeOnly.claude.starts[0]!, 'done');
    await drain();

    const withCursor = setup(4870, { cursorCalls: PASS_VERDICT });
    await withCursor.service.startRun({
      slug: 'c',
      workflow: triggered(CURSOR_CALLER_WF),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    expect(withCursor.ensureVerdict).toHaveBeenCalledTimes(1);
    completeTurn(withCursor.cursor.starts[0]!, 'done');
    await drain();
  });

  it('a refused merge strips the call-awareness block too — the degraded turn is never told it May call agents it has no tools for', async () => {
    const { service, cursor } = setup(4870, {
      cursorCalls: { status: 'pass', version: 'v1', probedAt: 1, reason: null },
      mergeOk: false,
    });
    await service.startRun({
      slug: 'c',
      workflow: triggered(CURSOR_CALLER_WF),
      cwd: dir,
      prompt: 'go',
    });
    await drain();
    const caller = cursor.starts[0]!;
    expect(caller.input.mcpEndpoint ?? null).toBeNull();
    // Every degrade surface must agree: no endpoint means no awareness block —
    // a prompt advertising call_agent on a turn without the tools sends the
    // model chasing tools that do not exist. The role itself survives.
    expect(caller.input.systemPrompt).toContain('You orchestrate.');
    expect(caller.input.systemPrompt).not.toContain('May call');
    completeTurn(caller, 'done');
    await drain();
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
    const { service, claude, callBroker, runDao } = setup();
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
    expect(caller.input.systemPrompt).toContain('answer_agent');

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
      question: 'Which color?',
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

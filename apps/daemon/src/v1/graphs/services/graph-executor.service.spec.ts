import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import type { BadRequestException } from '@packages/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
import { ProcessRegistry } from '../../agents/services/process-registry';
import type { Item } from '../../runs/entity/item.entity';
import type { NodeState } from '../../runs/entity/node-state.entity';
import type { Run } from '../../runs/entity/run.entity';
import type { Workflow } from '../graphs.types';
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
  constructor(readonly kind: 'claude' | 'cursor-agent') {}
  start(
    input: AgentTurnInput,
    onEvent: (event: AgentEvent) => void,
  ): { done: Promise<void>; cancel: () => void; respondApproval: unknown } {
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
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup(): {
  service: GraphExecutorService;
  claude: FakeAdapter;
  cursor: FakeAdapter;
  runDao: FakeRunDao;
  itemDao: FakeItemDao;
  nodeDao: FakeNodeStateDao;
  registry: ProcessRegistry;
  approvals: ApprovalRegistry;
} {
  const claude = new FakeAdapter('claude');
  const cursor = new FakeAdapter('cursor-agent');
  const runDao = new FakeRunDao();
  const itemDao = new FakeItemDao();
  const nodeDao = new FakeNodeStateDao();
  const registry = new ProcessRegistry();
  const approvals = new ApprovalRegistry();
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
  it('rejects running a workflow with call edges — the call runtime is not shipped yet', async () => {
    // Milestone-1 guard: without it, a call-only callee has no producers and
    // schedule() would launch it at run start with only the seed prompt.
    // Milestone 2 (CallBroker + MCP endpoint) removes this guard.
    const { service, claude, runDao } = setup();
    let code: string | undefined;
    try {
      await service.startRun({
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
    } catch (err) {
      code = (err as BadRequestException).errorCode;
    }
    expect(code).toBe('GRAPH_CALL_RUNTIME_UNAVAILABLE');
    expect(claude.starts).toHaveLength(0);
    expect(runDao.runs.size).toBe(0);
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

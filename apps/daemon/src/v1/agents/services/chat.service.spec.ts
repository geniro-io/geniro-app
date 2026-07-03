import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import type { AgentKind } from '../../runs/runs.types';
import type { AgentEvent, AgentTurnInput } from '../adapters/adapter.types';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAdapter } from '../adapters/cursor/cursor.adapter';
import type { RunItemEvent } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { AgentEventBus } from './agent-events.bus';
import { ChatService } from './chat.service';
import { ProcessRegistry } from './process-registry';

// ── In-memory fakes (the DAOs ignore the passed EntityManager) ───────────────
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

class FakeNodeStateDao {
  readonly saved: string[] = [];
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
} {
  let onEvent: ((event: AgentEvent) => void) | null = null;
  let resolveDone: (() => void) | null = null;
  const start = vi.fn(
    (input: AgentTurnInput, cb: (event: AgentEvent) => void) => {
      void input;
      onEvent = cb;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      return { done, cancel: vi.fn() };
    },
  );
  return {
    adapter: { kind, start } as unknown as ClaudeAdapter,
    start,
    emit: (event) => onEvent?.(event),
    finish: () => resolveDone?.(),
  };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await tick();
  }
}

function setup() {
  const runDao = new FakeRunDao();
  const itemDao = new FakeItemDao();
  const nodeDao = new FakeNodeStateDao();
  const published: RunItemEvent[] = [];
  const bus = {
    publish: (event: RunItemEvent) => published.push(event),
  } as unknown as AgentEventBus;
  const registry = new ProcessRegistry();
  const claude = fakeAdapter('claude');
  const cursor = fakeAdapter('cursor-agent');
  const em = {
    fork: () => ({ clear: () => undefined }),
  } as unknown as EntityManager;
  const service = new ChatService(
    em,
    runDao as unknown as RunDao,
    itemDao as unknown as ItemDao,
    nodeDao as unknown as NodeStateDao,
    bus,
    registry,
    claude.adapter,
    cursor.adapter as unknown as CursorAdapter,
  );
  return { service, runDao, itemDao, nodeDao, published, registry, claude };
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
    claude.emit({ type: 'turn_complete', usage: null, stopReason: 'end_turn' });
    claude.finish();
    await drain();

    expect(
      published.map((e) => `${e.item.seq}:${e.item.kind}/${e.item.role ?? ''}`),
    ).toEqual(['0:message/user', '1:message/assistant', '2:turn_complete/']);
    expect((await runDao.getById(run.id))?.status).toBe('completed');
  });

  it('rejects a concurrent turn on the same run with RUN_BUSY', async () => {
    const { service, claude } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });

    await service.sendMessage(run.id, 'first'); // turn in flight, not finished
    await expect(service.sendMessage(run.id, 'second')).rejects.toThrow();

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
    claude.emit({ type: 'turn_complete', usage: null, stopReason: null });
    claude.finish();
    await drain();

    expect(nodeDao.saved).toEqual(['new-sid']);
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
});

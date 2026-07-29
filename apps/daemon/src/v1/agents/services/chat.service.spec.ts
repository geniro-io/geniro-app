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
import type {
  ClaudeModesCapability,
  RunDeltaEvent,
  RunItemEvent,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { AgentEventBus } from './agent-events.bus';
import { ApprovalRegistry } from './approval-registry';
import type { AttachmentStoreService } from './attachment-store.service';
import { ChatService } from './chat.service';
import type { ClaudeProbeService } from './claude-probe.service';
import { PartialStreamService } from './partial-stream.service';
import { ProcessRegistry } from './process-registry';
import type { SkillHarvestStore } from './skill-harvest.store';

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
  failNextKind: string | null = null;
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
  handles: { respondApproval: ReturnType<typeof vi.fn> }[];
} {
  let onEvent: ((event: AgentEvent) => void) | null = null;
  let resolveDone: (() => void) | null = null;
  const handles: { respondApproval: ReturnType<typeof vi.fn> }[] = [];
  const start = vi.fn(
    (input: AgentTurnInput, cb: (event: AgentEvent) => void) => {
      void input;
      onEvent = cb;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const handle = {
        done,
        cancel: vi.fn(),
        // A live turn delivers verdicts — true is the realistic default.
        respondApproval: vi.fn(() => true),
      };
      handles.push(handle);
      return handle;
    },
  );
  return {
    adapter: {
      kind,
      start,
      // Mirrors the real adapters: only claude has a question channel.
      questionToolName: kind === 'claude' ? 'AskUserQuestion' : null,
      // Mirrors the real adapters: only claude can stream partial text.
      supportsLiveStream: () => Promise.resolve(kind === 'claude'),
    } as unknown as ClaudeAdapter,
    start,
    emit: (event) => onEvent?.(event),
    finish: () => resolveDone?.(),
    handles,
  };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await tick();
  }
}

function setup(opts: { claudeModes?: ClaudeModesCapability } = {}) {
  const runDao = new FakeRunDao();
  const itemDao = new FakeItemDao();
  const nodeDao = new FakeNodeStateDao();
  const published: RunItemEvent[] = [];
  const deltas: RunDeltaEvent[] = [];
  const bus = {
    publish: (event: RunItemEvent) => published.push(event),
    publishDelta: (event: RunDeltaEvent) => deltas.push(event),
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
  const claudeModes: ClaudeModesCapability = opts.claudeModes ?? {
    acceptEdits: 'pass',
    plan: 'pass',
    version: 'claude-test',
    probedAt: 0,
    reason: null,
  };
  const attachments = {
    save: () => ({ id: 'att-0', mediaType: 'image/png' }),
    pathOf: (runId: string, id: string) => `/tmp/${runId}/${id}`,
  } as unknown as AttachmentStoreService;
  const partials = new PartialStreamService(bus);
  const claudeProbe = {
    capability: () => claudeModes,
    ensureVerdict: vi.fn(async () => claudeModes),
    wireCapability: () => claudeModes,
  } as unknown as ClaudeProbeService;
  const service = new ChatService(
    em,
    runDao as unknown as RunDao,
    itemDao as unknown as ItemDao,
    nodeDao as unknown as NodeStateDao,
    bus,
    registry,
    approvals,
    claude.adapter,
    cursor.adapter as unknown as CursorAdapter,
    claudeProbe,
    skillHarvest,
    attachments,
    partials,
  );
  return {
    service,
    deltas,
    partials,
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
    claude.emit({ type: 'turn_complete', usage: null, stopReason: 'end_turn' });
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
    claude.emit({ type: 'turn_complete', usage: null, stopReason: 'end_turn' });
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
    claude.emit({ type: 'turn_complete', usage: null, stopReason: null });
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
    claude.emit({ type: 'turn_complete', usage: null, stopReason: null });
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

  it("createChat defaults claude to 'ask', pins cursor to 'auto', and rejects a non-auto cursor mode", async () => {
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
    const cursorRun = await service.createChat({
      agentKind: 'cursor-agent',
      cwd: dir,
    });
    expect(cursorRun.approval).toBe('auto');
    await expect(
      service.createChat({
        agentKind: 'cursor-agent',
        cwd: dir,
        approval: 'ask',
      }),
    ).rejects.toThrow("cursor chats run 'auto' only");
  });

  it('updateSettings flips the mode between turns, 409s mid-turn, and 400s a non-auto cursor mode', async () => {
    const { service, registry } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    const updated = await service.updateSettings(run.id, {
      approval: 'acceptEdits',
    });
    expect(updated.approval).toBe('acceptEdits');

    // A claimed run is a turn in flight — settings are locked.
    expect(registry.tryClaim(run.id)).toBe(true);
    await expect(
      service.updateSettings(run.id, { approval: 'auto' }),
    ).rejects.toThrow('a turn is in flight');

    const cursorRun = await service.createChat({
      agentKind: 'cursor-agent',
      cwd: dir,
    });
    await expect(
      service.updateSettings(cursorRun.id, { approval: 'ask' }),
    ).rejects.toThrow("cursor chats run 'auto' only");
    const pinned = await service.updateSettings(cursorRun.id, {
      approval: 'auto',
    });
    expect(pinned.approval).toBe('auto');
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

  it('locks the model mid-turn like the approval mode — a claimed run 409s', async () => {
    const { service, registry } = setup();
    const run = await service.createChat({ agentKind: 'claude', cwd: dir });
    expect(registry.tryClaim(run.id)).toBe(true);
    await expect(
      service.updateSettings(run.id, { model: 'opus' }),
    ).rejects.toThrow('a turn is in flight');
  });

  it('reverts and 409s a settings flip when a turn claims the run during the write — never ACKs a mode the in-flight turn cannot honor', async () => {
    const { service, runDao, registry } = setup();
    const run = await service.createChat({
      agentKind: 'claude',
      cwd: dir,
      approval: 'auto',
      model: 'sonnet',
    });
    // Model a concurrent sendMessage claiming the run mid-write: the claim
    // lands after updateSettings' pre-check but before its post-check.
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
    // Reverted WHOLE: mode back to 'auto' and model back to 'sonnet'. A revert
    // that restored only the mode would leave the in-flight turn's own run row
    // naming a model that turn never spawned with.
    const reverted = await runDao.getById(run.id);
    expect(reverted?.approval).toBe('auto');
    expect(reverted?.model).toBe('sonnet');
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

  it('sendMessage passes the run row mode to the adapter; a legacy null row passes none', async () => {
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

    // A pre-selector row (approval null) keeps the exact legacy spawn.
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
    ).toBeUndefined();
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
        response: 'Blue',
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
    claude.emit({ type: 'turn_complete', usage: null, stopReason: 'end_turn' });
    claude.finish();
    await drain();
    expect((await runDao.getById(run.id))?.status).toBe('failed');
    expect(approvals.listByRun(run.id)).toEqual([]);
  });
});

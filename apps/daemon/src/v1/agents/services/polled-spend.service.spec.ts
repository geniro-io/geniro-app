import type { EntityManager } from '@mikro-orm/sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Item } from '../../runs/entity/item.entity';
import type { NodeState } from '../../runs/entity/node-state.entity';
import type { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import { freshVocabularyStore } from '../adapters/__tests__/fresh-vocabulary-store';
import type {
  AccountSpendQuery,
  AccountSpendReply,
  AdapterConfig,
} from '../adapters/adapter.types';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';
import type { ItemDao } from '../dao/item.dao';
import type { NodeStateDao } from '../dao/node-state.dao';
import type { RunDao } from '../dao/run.dao';
import {
  type ConversationSpend,
  readPolledSpendLedger,
  spendBucket,
} from '../utils/polled-spend-ledger';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import type { AgentEventBus } from './agent-events.bus';
import { PolledSpendService } from './polled-spend.service';

const em = { fork: () => em } as unknown as EntityManager;

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** The clock every case runs at, unless it moves it. */
const NOW = 1_790_000_000_000;

/**
 * The REAL cursor adapter with its MACHINE stood in for — the Keychain read and
 * the CLI's identity file, the only two things a poll needs from this computer,
 * plus the delegates its store names. Everything else (the request, the
 * reader, the ledger, the write, the announce) is the real implementation.
 */
class MachineCursorAdapter extends CursorAcpAdapter {
  readonly spawnAsks: string[][] = [];

  constructor(private readonly delegates: Record<string, string[]> = {}) {
    super({ vocabularyStore: freshVocabularyStore() });
  }

  protected override async readAccountIdentity(): Promise<{
    teamId: number;
    userId: number;
  } | null> {
    return { teamId: 1, userId: 2 };
  }

  protected override async readAccessToken(): Promise<string | null> {
    return 'token';
  }

  override async spawnedConversations(
    conversationIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    this.spawnAsks.push([...conversationIds]);
    return new Map(
      conversationIds
        .filter((id) => this.delegates[id] !== undefined)
        .map((id) => [id, this.delegates[id] ?? []]),
    );
  }
}

function cursorRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    agentKind: AgentKind.CursorAgent,
    workflowId: null,
    polledCostCents: null,
    polledCostEvents: null,
    ...overrides,
  } as Run;
}

/** One node row, as `listByRun` answers it. */
function node(overrides: Partial<NodeState> & { nodeId: string }): NodeState {
  return {
    runId: 'run-1',
    agentKind: AgentKind.CursorAgent,
    agentSessionId: null,
    sessionIds: null,
    polledSpend: null,
    polledCostCents: null,
    polledCostEvents: null,
    createdAt: new Date(NOW - 2 * HOUR),
    ...overrides,
  } as NodeState;
}

/** A node whose single conversation is `sessionId`. */
function holding(
  sessionId: string,
  overrides: Partial<NodeState> = {},
): NodeState {
  return node({ nodeId: 'node-0', agentSessionId: sessionId, ...overrides });
}

/** A stored ledger, as the column holds it. */
function ledger(entries: Record<string, ConversationSpend>): string {
  return JSON.stringify(entries);
}

/** The slice of an `AgentEventBus` item event the service reads. */
interface ItemEvent {
  runId: string;
  item: { nodeId: string | null };
}

function itemOn(runId: string, nodeId: string | null = null): ItemEvent {
  return { runId, item: { nodeId } };
}

interface Harness {
  service: PolledSpendService;
  adapter: MachineCursorAdapter;
  runWrites: { id: string; data: Partial<Run> }[];
  nodeWrites: {
    runId: string;
    nodeId: string;
    ledger: string | null;
    cents: number;
    events: number;
  }[];
  published: unknown[];
  onItem: (event: ItemEvent) => void;
  counts: { listed: number; nodeReads: number };
  reads: { where: unknown; options: unknown }[];
  /** The read for runs whose agent pool holds the polled CLI. */
  poolReads: { where: unknown; options: unknown }[];
}

function harness(options: {
  runs: Run[];
  nodes: Record<string, NodeState[]>;
  /** Runs found through a cursor NODE rather than through their own agent. */
  cursorNodeRunIds?: string[];
  /** A workflow node's own agent, keyed `<runId>/<nodeId>`. */
  nodeAgents?: Record<string, AgentKind | null>;
  /** Each run's call records, as `callRecordRows` answers them. */
  calls?: Record<string, { calleeNodeId: string; sessionId: string }[]>;
  delegates?: Record<string, string[]>;
}): Harness {
  const runWrites: Harness['runWrites'] = [];
  const nodeWrites: Harness['nodeWrites'] = [];
  const published: unknown[] = [];
  const counts = { listed: 0, nodeReads: 0 };
  const reads: Harness['reads'] = [];
  const poolReads: Harness['reads'] = [];
  let onItem: (event: ItemEvent) => void = () => undefined;

  const runDao = {
    // Honours the FILTER: the service makes two different reads, the 1:1
    // cursor chats and then the runs merely holding a cursor node.
    getAll: async (
      where?: {
        id?: { $in?: string[] };
        agentKind?: AgentKind;
        workflowSnapshot?: { $like: string };
      },
      opts?: unknown,
    ) => {
      // The pool-candidate read: answered, but not counted as a listing —
      // `counts.listed` is how a spec tells that a poll ran at all.
      const like = where?.workflowSnapshot?.$like;
      if (like !== undefined) {
        poolReads.push({ where, options: opts });
        const needle = like.replaceAll('%', '');
        return options.runs.filter((run) =>
          (run.workflowSnapshot ?? '').includes(needle),
        );
      }
      counts.listed += 1;
      reads.push({ where, options: opts });
      const ids = where?.id?.$in;
      if (ids !== undefined) {
        return options.runs.filter((run) => ids.includes(run.id));
      }
      return options.runs.filter((run) => run.agentKind === where?.agentKind);
    },
    getById: async (id: string) =>
      options.runs.find((run) => run.id === id) ?? null,
    updateWithoutActivity: async (id: string, data: Partial<Run>) => {
      runWrites.push({ id, data });
      return 1;
    },
  } as unknown as RunDao;

  const nodeStates = {
    runIdsForAgent: async () => options.cursorNodeRunIds ?? [],
    getByRunNode: async (runId: string, nodeId: string) => {
      counts.nodeReads += 1;
      const kind = options.nodeAgents?.[`${runId}/${nodeId}`];
      return kind === undefined
        ? null
        : ({ nodeId, agentKind: kind } as NodeState);
    },
    listByRun: async (runId: string) => options.nodes[runId] ?? [],
    writePolledSpend: async (
      runId: string,
      nodeId: string,
      spend: { ledger: string | null; cents: number; events: number },
    ) => {
      nodeWrites.push({ runId, nodeId, ...spend });
    },
  } as unknown as NodeStateDao;

  const itemDao = {
    callRecordRows: async (runId: string) =>
      (options.calls?.[runId] ?? []).map(
        (call) =>
          ({
            kind: 'call_result',
            payload: JSON.stringify({ callerNodeId: 'manager', ...call }),
          }) as Pick<Item, 'kind' | 'payload' | 'createdAt'>,
      ),
  } as unknown as ItemDao;

  const bus = {
    all: () => ({
      subscribe: (fn: (event: ItemEvent) => void) => {
        onItem = fn;
        return { unsubscribe: () => undefined };
      },
    }),
    allDeleted: () => ({
      subscribe: () => ({ unsubscribe: () => undefined }),
    }),
    publishRunStatus: (status: unknown) => published.push(status),
  } as unknown as AgentEventBus;

  const adapter = new MachineCursorAdapter(options.delegates);
  const service = new PolledSpendService(
    runDao,
    nodeStates,
    itemDao,
    em,
    bus,
    new AgentAdapterRegistry([new ClaudeAdapter(), adapter]),
  );
  service.onModuleInit();
  return {
    service,
    adapter,
    runWrites,
    nodeWrites,
    published,
    onItem: (event) => onItem(event),
    counts,
    reads,
    poolReads,
  };
}

/** One usage event in the shape Cursor's endpoint answers it. */
function event(
  conversationId: string,
  chargedCents: number,
  atMs: number = NOW - HOUR,
): unknown {
  return {
    conversationId,
    chargedCents,
    isChargeable: true,
    timestamp: String(atMs),
    model: 'grok-4.7',
  };
}

/** The key the reader files an {@link event} under. */
const keyOf = (atMs: number = NOW - HOUR): string => `${atMs}|grok-4.7`;

/** Answer every page with these events, and record each request's window. */
function answerWith(...events: unknown[]): {
  windows: { start: number; end: number }[];
} {
  const windows: { start: number; end: number }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        startDate: string;
        endDate: string;
      };
      windows.push({
        start: Number(body.startDate),
        end: Number(body.endDate),
      });
      return {
        ok: true,
        json: async () => ({
          usageEventsDisplay: events,
          totalUsageEventsCount: events.length,
        }),
      };
    }),
  );
  return { windows };
}

/** Let the bus subscriber's own async work settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Pin the clock, and return the way to move it.
 *
 * `Date.now` rather than fake timers: the floors are the whole subject of some
 * cases and {@link flush} needs a real `setTimeout` to let promises land.
 */
function at(startMs: number): (nowMs: number) => void {
  const now = vi.spyOn(Date, 'now').mockReturnValue(startMs);
  return (nowMs) => now.mockReturnValue(nowMs);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PolledSpendService', () => {
  it('prices a conversation and announces the run whose spend changed', async () => {
    at(NOW);
    const h = harness({
      runs: [cursorRun()],
      nodes: { 'run-1': [holding('conv-1')] },
    });
    answerWith(event('conv-1', 488.8));

    await h.service.refresh(true);

    expect(h.runWrites).toMatchObject([
      { id: 'run-1', data: { polledCostCents: 488.8, polledCostEvents: 1 } },
    ]);
    expect(h.nodeWrites).toMatchObject([
      { runId: 'run-1', nodeId: 'node-0', cents: 488.8, events: 1 },
    ]);
    expect(h.published).toEqual([
      { runId: 'run-1', status: null, spendUpdatedAt: NOW },
    ]);
  });

  it('REPLACES a charge the account revised after an earlier poll read it', async () => {
    // The reported undercount. Cursor lists a long request early and raises its
    // charge as it runs; the watermark this replaced counted each event once,
    // at first sight — measured on a real node: ten events seen, $8.44
    // recorded, $134.86 billed.
    at(NOW);
    const stored = ledger({
      'conv-1': {
        settled: {},
        settledThroughMs: NOW - 3 * HOUR,
        open: { [keyOf()]: [NOW - HOUR, 84, 'grok-4.7'] },
      },
    });
    const h = harness({
      runs: [cursorRun({ polledCostCents: 84, polledCostEvents: 1 })],
      nodes: {
        'run-1': [
          holding('conv-1', {
            polledSpend: stored,
            polledCostCents: 84,
            polledCostEvents: 1,
          }),
        ],
      },
    });
    answerWith(event('conv-1', 1_348.6));

    await h.service.refresh(true);

    expect(h.runWrites).toMatchObject([
      { id: 'run-1', data: { polledCostCents: 1_348.6, polledCostEvents: 1 } },
    ]);
  });

  it('says nothing about a run whose charges did not move', async () => {
    // A poll covers every polled conversation on the machine, so announcing
    // each one would put an event per thread on the wire every minute.
    at(NOW);
    const stored = ledger({
      'conv-1': {
        settled: {},
        settledThroughMs: NOW - 3 * HOUR,
        open: { [keyOf()]: [NOW - HOUR, 488.8, 'grok-4.7'] },
      },
    });
    const h = harness({
      runs: [
        cursorRun({
          polledCostCents: 488.8,
          polledCostEvents: 1,
          polledSpendBuckets: JSON.stringify({
            [spendBucket(NOW - HOUR, 'grok-4.7')]: 488.8,
          }),
        }),
      ],
      nodes: {
        'run-1': [
          holding('conv-1', {
            polledSpend: stored,
            polledCostCents: 488.8,
            polledCostEvents: 1,
          }),
        ],
      },
    });
    answerWith(event('conv-1', 488.8));

    await h.service.refresh(true);

    expect(h.nodeWrites).toEqual([]);
    expect(h.runWrites).toEqual([]);
    expect(h.published).toEqual([]);
  });

  it('settles an event a day old once a poll read its whole window, and never re-reads it', async () => {
    at(NOW);
    const old = NOW - 2 * DAY;
    const h = harness({
      runs: [cursorRun()],
      nodes: {
        'run-1': [holding('conv-1', { createdAt: new Date(NOW - 3 * DAY) })],
      },
    });
    answerWith(event('conv-1', 30, old), event('conv-1', 5));

    await h.service.refresh(true);

    const conv = readPolledSpendLedger(h.nodeWrites[0]?.ledger ?? null).get(
      'conv-1',
    );
    expect(conv).toEqual({
      settled: { [spendBucket(old, 'grok-4.7')]: [30, 1] },
      settledThroughMs: NOW - DAY,
      open: { [keyOf()]: [NOW - HOUR, 5, 'grok-4.7'] },
    });
  });

  it('splits a run’s bill by the DAY and the MODEL each charge was billed under', async () => {
    // One figure per run filed a whole month of a workflow's cursor bill under
    // its last day and no model, so Stats drew neither the day it was spent
    // nor the model that spent it.
    at(NOW);
    const h = harness({
      runs: [cursorRun()],
      nodes: {
        'run-1': [holding('conv-1', { createdAt: new Date(NOW - 5 * DAY) })],
      },
    });
    answerWith(event('conv-1', 30, NOW - 3 * DAY), event('conv-1', 5), {
      ...(event('conv-1', 7, NOW - 2 * HOUR) as object),
      model: 'kimi-k3',
    });

    await h.service.refresh(true);

    expect(JSON.parse(String(h.runWrites[0]?.data.polledSpendBuckets))).toEqual(
      {
        [spendBucket(NOW - 3 * DAY, 'grok-4.7')]: 30,
        ...(spendBucket(NOW - HOUR, 'grok-4.7') ===
        spendBucket(NOW - 3 * DAY, 'grok-4.7')
          ? {}
          : { [spendBucket(NOW - HOUR, 'grok-4.7')]: 5 }),
        [spendBucket(NOW - 2 * HOUR, 'kimi-k3')]: 7,
      },
    );
  });

  it('settles nothing when the walk could not read its whole window', async () => {
    // A cut-short walk saw only part of the window; anything it missed may
    // still be revised, so nothing may be frozen on its word.
    at(NOW);
    const h = harness({
      runs: [cursorRun()],
      nodes: {
        'run-1': [holding('conv-1', { createdAt: new Date(NOW - 3 * DAY) })],
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          usageEventsDisplay: [event('conv-1', 30, NOW - 2 * DAY)],
          totalUsageEventsCount: 1_000_000,
        }),
      })),
    );

    await h.service.refresh(true);

    const conv = readPolledSpendLedger(h.nodeWrites[0]?.ledger ?? null).get(
      'conv-1',
    );
    expect(conv?.settled).toEqual({});
    expect(conv?.settledThroughMs).toBe(NOW - 3 * DAY - HOUR);
    expect(h.nodeWrites[0]?.cents).toBe(30);
  });

  it('starts the window at the oldest open boundary, and a new conversation where its node began', async () => {
    at(NOW);
    const settledAt = NOW - 30 * HOUR;
    const h = harness({
      runs: [cursorRun()],
      nodes: {
        'run-1': [
          holding('conv-old', {
            polledSpend: ledger({
              'conv-old': {
                settled: {
                  [spendBucket(settledAt - DAY, 'grok-4.7')]: [10, 1],
                },
                settledThroughMs: settledAt,
                open: {},
              },
            }),
          }),
          node({
            nodeId: 'node-1',
            agentSessionId: 'conv-new',
            createdAt: new Date(NOW - 5 * HOUR),
          }),
        ],
      },
    });
    const { windows } = answerWith();

    await h.service.refresh(true);

    expect(windows).toEqual([{ start: settledAt, end: NOW }]);

    // Alone, the new conversation is asked about from an hour before its node.
    const fresh = harness({
      runs: [cursorRun()],
      nodes: {
        'run-1': [
          node({
            nodeId: 'node-1',
            agentSessionId: 'conv-new',
            createdAt: new Date(NOW - 5 * HOUR),
          }),
        ],
      },
    });
    const second = answerWith();
    await fresh.service.refresh(true);
    expect(second.windows).toEqual([{ start: NOW - 6 * HOUR, end: NOW }]);
  });

  it('never asks further back than the account keeps', async () => {
    at(NOW);
    const h = harness({
      runs: [cursorRun()],
      nodes: {
        'run-1': [holding('conv-1', { createdAt: new Date(NOW - 90 * DAY) })],
      },
    });
    const { windows } = answerWith();

    await h.service.refresh(true);

    expect(windows[0]?.start).toBe(NOW - 30 * DAY);
  });

  it('prices the conversations CALLERS held with a node, from its call records', async () => {
    // The $657 a real account billed to sixty-one call conversations whose
    // sessions are on no session history — runs older than that column — but on
    // the `call_result` row every call writes.
    at(NOW);
    const workflow = cursorRun({
      id: 'wf',
      agentKind: null,
      workflowId: 'dev',
    });
    const h = harness({
      runs: [workflow],
      cursorNodeRunIds: ['wf'],
      nodes: {
        wf: [
          node({ runId: 'wf', nodeId: 'qa' }),
          node({ runId: 'wf', nodeId: 'manager', agentKind: AgentKind.Claude }),
        ],
      },
      calls: {
        wf: [
          { calleeNodeId: 'qa', sessionId: 'call-conv' },
          // A call to a node of another CLI names a session this account has
          // never heard of.
          { calleeNodeId: 'manager', sessionId: 'claude-conv' },
        ],
      },
    });
    answerWith(event('call-conv', 145.25), event('claude-conv', 999));

    await h.service.refresh(true);

    expect(h.nodeWrites).toMatchObject([{ nodeId: 'qa', cents: 145.25 }]);
    expect(h.runWrites).toMatchObject([
      { id: 'wf', data: { polledCostCents: 145.25, polledCostEvents: 1 } },
    ]);
  });

  it('prices every DELEGATE a conversation spawned, on the node that launched it', async () => {
    // The largest share of the reported gap: each cursor sub-agent is billed
    // under its own conversation id, which no turn ever names.
    at(NOW);
    const h = harness({
      runs: [cursorRun()],
      nodes: { 'run-1': [holding('parent')] },
      delegates: { parent: ['child-1', 'child-2'] },
    });
    answerWith(
      event('parent', 100),
      event('child-1', 40),
      event('child-2', 2, NOW - 2 * HOUR),
    );

    await h.service.refresh(true);

    expect(h.adapter.spawnAsks).toEqual([['parent']]);
    expect(h.nodeWrites).toMatchObject([
      { nodeId: 'node-0', cents: 142, events: 3 },
    ]);
  });

  it('starts a newly found delegate where its parent is still open, not where the node began', async () => {
    // On a chat weeks old, starting from the node would make every new delegate
    // a walk through weeks of the account.
    at(NOW);
    const parentOpenFrom = NOW - 26 * HOUR;
    const h = harness({
      runs: [cursorRun()],
      nodes: {
        'run-1': [
          holding('parent', {
            createdAt: new Date(NOW - 20 * DAY),
            polledSpend: ledger({
              parent: {
                settled: {},
                settledThroughMs: parentOpenFrom,
                open: {},
              },
            }),
          }),
        ],
      },
      delegates: { parent: ['child'] },
    });
    const { windows } = answerWith();

    await h.service.refresh(true);

    expect(windows).toEqual([{ start: parentOpenFrom, end: NOW }]);
  });

  it('counts a conversation on ONE node, however many name it', async () => {
    // A delegate id can also turn up as a session another node resumed; billing
    // it to both would double the figure the user checks against their bill.
    at(NOW);
    const h = harness({
      runs: [cursorRun()],
      nodes: {
        'run-1': [
          holding('parent'),
          node({ nodeId: 'node-1', agentSessionId: 'shared' }),
        ],
      },
      delegates: { parent: ['shared'] },
    });
    answerWith(event('shared', 10));

    await h.service.refresh(true);

    expect(h.runWrites).toMatchObject([
      { id: 'run-1', data: { polledCostCents: 10, polledCostEvents: 1 } },
    ]);
  });

  it('keeps the total of a node priced before the ledger existed whose start the account no longer covers', async () => {
    // Re-deriving it from a window that cannot see its start would replace a
    // real figure with a fraction of it.
    at(NOW);
    const h = harness({
      runs: [cursorRun({ polledCostCents: 500, polledCostEvents: 5 })],
      nodes: {
        'run-1': [
          holding('conv-1', {
            createdAt: new Date(NOW - 45 * DAY),
            polledCostCents: 500,
            polledCostEvents: 5,
          }),
        ],
      },
    });
    answerWith(
      event('conv-1', 20, NOW - 10 * DAY),
      event('conv-1', 7, NOW + 1),
    );

    await h.service.refresh(true);

    // The old event is behind the carried total's boundary; the new one adds.
    expect(h.runWrites).toMatchObject([
      { id: 'run-1', data: { polledCostCents: 507, polledCostEvents: 6 } },
    ]);
  });

  it('RE-DERIVES the total of a node priced before the ledger existed, when the account still covers its start', async () => {
    // Its old figure was the undercount; this is the fix reaching history.
    at(NOW);
    const h = harness({
      runs: [cursorRun({ polledCostCents: 8.44, polledCostEvents: 10 })],
      nodes: {
        'run-1': [
          holding('conv-1', {
            createdAt: new Date(NOW - 5 * DAY),
            polledCostCents: 8.44,
            polledCostEvents: 10,
          }),
        ],
      },
    });
    answerWith(event('conv-1', 13_486, NOW - 4 * DAY));

    await h.service.refresh(true);

    expect(h.runWrites).toMatchObject([
      { id: 'run-1', data: { polledCostCents: 13_486, polledCostEvents: 1 } },
    ]);
  });

  it('prices a cursor node inside a WORKFLOW, whose run names no agent', async () => {
    at(NOW);
    const workflow = cursorRun({
      id: 'wf',
      agentKind: null,
      workflowId: 'dev',
    });
    const h = harness({
      runs: [workflow],
      cursorNodeRunIds: ['wf'],
      nodes: {
        wf: [node({ runId: 'wf', nodeId: 'qa', agentSessionId: 'conv-wf' })],
      },
    });
    answerWith(event('conv-wf', 1_234.5));

    await h.service.refresh(true);

    expect(h.runWrites).toMatchObject([
      { id: 'wf', data: { polledCostCents: 1_234.5, polledCostEvents: 1 } },
    ]);
  });

  it('ignores a NON-cursor node of a run it reached through a cursor one', async () => {
    at(NOW);
    const workflow = cursorRun({
      id: 'wf',
      agentKind: null,
      workflowId: 'dev',
    });
    const h = harness({
      runs: [workflow],
      cursorNodeRunIds: ['wf'],
      nodes: {
        wf: [
          node({
            runId: 'wf',
            nodeId: 'engineer',
            agentKind: AgentKind.Claude,
            agentSessionId: 'claude-conv',
          }),
        ],
      },
    });
    answerWith(event('claude-conv', 999));

    await h.service.refresh(true);

    expect(h.runWrites).toEqual([]);
  });

  it('reads only the run columns a poll uses, past the identity map, on both of its run listings', async () => {
    at(NOW);
    const workflow = cursorRun({
      id: 'wf',
      agentKind: null,
      workflowId: 'dev',
    });
    const h = harness({
      runs: [cursorRun(), workflow],
      cursorNodeRunIds: ['wf'],
      nodes: {
        'run-1': [holding('conv-1')],
        wf: [node({ runId: 'wf', nodeId: 'qa', agentSessionId: 'conv-wf' })],
      },
    });
    answerWith(event('conv-1', 10), event('conv-wf', 20));

    await h.service.refresh(true);

    expect(h.reads.map((read) => read.where)).toEqual([
      { agentKind: AgentKind.CursorAgent },
      { id: { $in: ['wf'] } },
    ]);
    for (const read of h.reads) {
      expect(read.options).toEqual({
        fields: [
          'id',
          'agentKind',
          'polledCostCents',
          'polledCostEvents',
          'polledSpendBuckets',
          'workflowSnapshot',
        ],
        disableIdentityMap: true,
      });
    }
    expect(h.poolReads).toEqual([
      {
        where: { workflowSnapshot: { $like: '%"agent":"cursor-agent"%' } },
        options: { fields: ['id'], disableIdentityMap: true },
      },
    ]);
  });

  it('prices a POOLED node whose cursor member held a conversation, whatever its last turn was stamped', async () => {
    at(NOW);
    const workflow = cursorRun({
      id: 'wf',
      agentKind: null,
      workflowId: 'dev',
      workflowSnapshot: JSON.stringify({
        nodes: [
          {
            id: 'eng',
            kind: 'agent',
            agent: 'claude',
            pool: [{ agent: 'cursor-agent' }],
          },
        ],
      }),
    });
    const h = harness({
      runs: [workflow],
      nodes: {
        wf: [
          node({
            runId: 'wf',
            nodeId: 'eng',
            agentKind: AgentKind.Claude,
            agentSessionId: 'conv-cursor',
          }),
        ],
      },
    });
    answerWith(event('conv-cursor', 25));

    await h.service.refresh(true);

    expect(h.nodeWrites.map((write) => write.nodeId)).toEqual(['eng']);
  });

  it('sums EVERY conversation a node held rather than keeping the last', async () => {
    at(NOW);
    const h = harness({
      runs: [cursorRun()],
      nodes: {
        'run-1': [
          holding('conv-new', {
            sessionIds: JSON.stringify(['conv-old', 'conv-new']),
          }),
        ],
      },
    });
    answerWith(event('conv-old', 100), event('conv-new', 25));

    await h.service.refresh(true);

    expect(h.runWrites).toMatchObject([
      { id: 'run-1', data: { polledCostCents: 125, polledCostEvents: 2 } },
    ]);
  });

  it('asks the account nothing when this machine holds no conversation of the CLI', async () => {
    at(NOW);
    const h = harness({ runs: [], nodes: {} });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await h.service.refresh(true);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('polls a minute after a cursor item, well inside the ambient floor', async () => {
    const clock = at(NOW);
    const h = harness({
      runs: [cursorRun()],
      nodes: { 'run-1': [holding('conv-1')] },
    });
    answerWith(event('conv-1', 10));
    await h.service.refresh(true);
    expect(h.counts.listed).toBe(1);

    clock(NOW + 30_000);
    h.onItem(itemOn('run-1'));
    await flush();
    expect(h.counts.listed).toBe(1);

    clock(NOW + 90_000);
    h.onItem(itemOn('run-1'));
    await flush();
    expect(h.counts.listed).toBe(2);
  });

  it('does not poll on an item from a run of another CLI', async () => {
    const clock = at(NOW);
    const h = harness({
      runs: [
        cursorRun(),
        cursorRun({ id: 'run-2', agentKind: AgentKind.Claude }),
      ],
      nodes: { 'run-1': [holding('conv-1')] },
    });
    answerWith(event('conv-1', 10));
    await h.service.refresh(true);

    clock(NOW + 90_000);
    h.onItem(itemOn('run-2'));
    await flush();

    expect(h.counts.listed).toBe(1);
  });

  it('polls on an item from a cursor NODE inside a workflow run, whose run row names no agent', async () => {
    const clock = at(NOW);
    const workflow = cursorRun({
      id: 'wf-1',
      agentKind: null,
      workflowId: 'dev',
    });
    const h = harness({
      runs: [cursorRun(), workflow],
      nodes: { 'run-1': [holding('conv-1')] },
      nodeAgents: {
        'wf-1/qa': AgentKind.CursorAgent,
        'wf-1/engineer': AgentKind.Claude,
      },
    });
    answerWith(event('conv-1', 10));
    await h.service.refresh(true);

    clock(NOW + 90_000);
    h.onItem(itemOn('wf-1', 'engineer'));
    await flush();
    expect(h.counts.listed).toBe(1);

    h.onItem(itemOn('wf-1', 'qa'));
    await flush();
    expect(h.counts.listed).toBe(2);
  });

  it('asks again about a node that has not yet named its agent, rather than filing it as not cursor', async () => {
    const clock = at(NOW);
    const workflow = cursorRun({
      id: 'wf-1',
      agentKind: null,
      workflowId: 'dev',
    });
    const nodeAgents: Record<string, AgentKind | null> = { 'wf-1/qa': null };
    const h = harness({
      runs: [cursorRun(), workflow],
      nodes: { 'run-1': [holding('conv-1')] },
      nodeAgents,
    });
    answerWith(event('conv-1', 10));
    await h.service.refresh(true);

    clock(NOW + 90_000);
    h.onItem(itemOn('wf-1', 'qa'));
    await flush();
    expect(h.counts.listed).toBe(1);

    nodeAgents['wf-1/qa'] = AgentKind.CursorAgent;
    h.onItem(itemOn('wf-1', 'qa'));
    await flush();
    expect(h.counts.nodeReads).toBe(2);
    expect(h.counts.listed).toBe(2);
  });

  it('says a workflow run holds polled spend when any of its nodes ran on such a CLI', async () => {
    const h = harness({
      runs: [],
      nodes: { 'wf-1': [node({ runId: 'wf-1', nodeId: 'qa' })] },
    });
    expect(await h.service.runHoldsPolledSpend('wf-1', null)).toBe(true);
    expect(await h.service.runHoldsPolledSpend('wf-2', null)).toBe(false);
    expect(
      await h.service.runHoldsPolledSpend('chat-1', AgentKind.CursorAgent),
    ).toBe(true);
    expect(
      await h.service.runHoldsPolledSpend('chat-2', AgentKind.Claude),
    ).toBe(false);
  });
});

/** A CLI that declares polled spend and answers with whatever it is handed. */
class FakePolledAdapter extends ClaudeAdapter {
  readonly queries: AccountSpendQuery[] = [];

  constructor(
    private readonly polls: boolean,
    private readonly answer: AccountSpendReply | null,
  ) {
    super();
  }

  override getConfig(): AdapterConfig {
    const base = super.getConfig();
    return { ...base, usage: { ...base.usage, polledSpend: this.polls } };
  }

  override async fetchAccountSpend(
    query: AccountSpendQuery,
  ): Promise<AccountSpendReply | null> {
    this.queries.push(query);
    return this.answer;
  }
}

describe('PolledSpendService — which CLIs it asks', () => {
  function withAdapter(adapter: FakePolledAdapter) {
    const writes: Partial<Run>[] = [];
    const run = cursorRun({ agentKind: AgentKind.Claude });
    const service = new PolledSpendService(
      {
        getAll: async (where?: { agentKind?: string }) =>
          where?.agentKind === run.agentKind ? [run] : [],
        updateWithoutActivity: async (_id: string, data: Partial<Run>) => {
          writes.push(data);
          return 1;
        },
      } as unknown as RunDao,
      {
        runIdsForAgent: async () => [],
        listByRun: async () => [
          node({
            nodeId: 'agent',
            agentKind: AgentKind.Claude,
            agentSessionId: 'sess-1',
          }),
        ],
        writePolledSpend: async () => undefined,
      } as unknown as NodeStateDao,
      { callRecordRows: async () => [] } as unknown as ItemDao,
      em,
      { publishRunStatus: () => undefined } as unknown as AgentEventBus,
      new AgentAdapterRegistry([adapter]),
    );
    return { service, writes };
  }

  it('asks a polled CLI’s OWN adapter, about every conversation it holds', async () => {
    at(NOW);
    const adapter = new FakePolledAdapter(true, {
      complete: true,
      events: [
        {
          conversationId: 'sess-1',
          key: 'k1',
          atMs: NOW - HOUR,
          cents: 200,
          model: 'm',
        },
        {
          conversationId: 'sess-1',
          key: 'k2',
          atMs: NOW - HOUR,
          cents: 50,
          model: 'm',
        },
      ],
    });
    const { service, writes } = withAdapter(adapter);

    await service.refresh(true);

    expect(adapter.queries).toHaveLength(1);
    expect([...adapter.queries[0]!.conversations]).toEqual(['sess-1']);
    expect(writes).toMatchObject([
      { polledCostCents: 250, polledCostEvents: 2 },
    ]);
  });

  it('never asks a CLI whose turns price themselves', async () => {
    const adapter = new FakePolledAdapter(false, {
      complete: true,
      events: [],
    });
    const { service } = withAdapter(adapter);

    await service.refresh(true);

    expect(adapter.queries).toHaveLength(0);
  });

  it('writes nothing when the account could not be read', async () => {
    // Null is "no cost reported", never an error and never a zero.
    const adapter = new FakePolledAdapter(true, null);
    const { service, writes } = withAdapter(adapter);

    await service.refresh(true);

    expect(adapter.queries).toHaveLength(1);
    expect(writes).toEqual([]);
  });
});

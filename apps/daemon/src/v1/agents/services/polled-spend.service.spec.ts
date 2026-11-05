import type { EntityManager } from '@mikro-orm/sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  DEFAULT_ACCOUNT,
  readPolledSpendLedger,
  spendBucket,
} from '../utils/polled-spend-ledger';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import type { AgentEventBus } from './agent-events.bus';
import type { ConfigDirPinService } from './config-dir-pin.service';
import { PolledSpendService } from './polled-spend.service';

const em = { fork: () => em } as unknown as EntityManager;

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** The clock every case runs at, unless it moves it. */
const NOW = 1_790_000_000_000;
/** A named configuration whose CLI identity cannot be read. */
const SIGNED_OUT_PROFILE = '/profiles/signed-out';

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

  protected override async readAccountIdentity(configDir: string): Promise<{
    teamId: number;
    userId: number;
  } | null> {
    return configDir === SIGNED_OUT_PROFILE ? null : { teamId: 1, userId: 2 };
  }

  /** The default login is `token`; a profile's is `token:<its directory>`. */
  protected override readProfileAccessToken(
    configDir: string,
  ): Promise<string | null> {
    return Promise.resolve(configDir === '' ? 'token' : `token:${configDir}`);
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
    teamId: null,
    polledCostCents: null,
    polledCostEvents: null,
    ...overrides,
  } as Run;
}

/** One member row, as `listByRun` answers it. */
function node(overrides: Partial<NodeState> & { memberId: string }): NodeState {
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

/** A member whose single conversation is `sessionId`. */
function holding(
  sessionId: string,
  overrides: Partial<NodeState> = {},
): NodeState {
  return node({ memberId: 'node-0', agentSessionId: sessionId, ...overrides });
}

/** A stored ledger, as the column holds it. */
function ledger(entries: Record<string, ConversationSpend>): string {
  return JSON.stringify(entries);
}

/** The slice of an `AgentEventBus` item event the service reads. */
interface ItemEvent {
  runId: string;
  item: { memberId: string | null };
}

function itemOn(runId: string, memberId: string | null = null): ItemEvent {
  return { runId, item: { memberId } };
}

interface Harness {
  service: PolledSpendService;
  adapter: MachineCursorAdapter;
  runWrites: { id: string; data: Partial<Run> }[];
  nodeWrites: {
    runId: string;
    memberId: string;
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
  /** The reads of runs' team copies, by the run ids each asked for. */
  snapshotReads: string[][];
  /** The `call_result` reads, each from the seq it read past. */
  callReads: { runId: string; afterSeq: number }[];
  /** Announce a run deleted, as `AgentEventBus.publishRunDeleted` does. */
  deleteRun: (runId: string) => void;
}

function harness(options: {
  runs: Run[];
  nodes: Record<string, NodeState[]>;
  /** Runs found through a cursor NODE rather than through their own agent. */
  cursorNodeRunIds?: string[];
  /** A team member's own agent, keyed `<runId>/<nodeId>`. */
  nodeAgents?: Record<string, AgentKind | null>;
  /** Each run's `call_result` records, as `rowsOfKinds` answers them. */
  calls?: Record<string, { calleeMemberId: string; sessionId: string }[]>;
  delegates?: Record<string, string[]>;
}): Harness {
  const runWrites: Harness['runWrites'] = [];
  const nodeWrites: Harness['nodeWrites'] = [];
  const published: unknown[] = [];
  const counts = { listed: 0, nodeReads: 0 };
  const reads: Harness['reads'] = [];
  const poolReads: Harness['reads'] = [];
  const snapshotReads: string[][] = [];
  let onItem: (event: ItemEvent) => void = () => undefined;
  let onDeleted: (runId: string) => void = () => undefined;

  const runDao = {
    // Honours the FILTER: the service makes two different reads, the 1:1
    // cursor chats and then the runs merely holding a cursor member.
    getAll: async (
      where?: {
        id?: { $in?: string[] };
        agentKind?: AgentKind;
        teamSnapshot?: { $like: string } | { $ne: null } | null;
        teamId?: { $ne: null };
        createdAt?: { $gte: Date };
      },
      opts?: unknown,
    ) => {
      // The team runs with no team copy yet, and the later re-check of
      // which of them have one now.
      if (where?.teamSnapshot === null) {
        return options.runs.filter(
          (run) => run.teamId !== null && run.teamSnapshot === null,
        );
      }
      if (where?.teamSnapshot !== undefined && '$ne' in where.teamSnapshot) {
        const ids = where.id?.$in ?? [];
        return options.runs.filter(
          (run) => ids.includes(run.id) && run.teamSnapshot !== null,
        );
      }
      // The pool-candidate read: answered, but not counted as a listing —
      // `counts.listed` is how a spec tells that a poll ran at all.
      const like =
        where?.teamSnapshot !== undefined &&
        where.teamSnapshot !== null &&
        '$like' in where.teamSnapshot
          ? where.teamSnapshot.$like
          : undefined;
      if (like !== undefined) {
        poolReads.push({ where, options: opts });
        const needle = like.replaceAll('%', '');
        const since = where?.createdAt?.$gte.getTime() ?? -Infinity;
        return options.runs.filter(
          (run) =>
            (run.teamSnapshot ?? '').includes(needle) &&
            (run.createdAt?.getTime() ?? 0) >= since,
        );
      }
      const ids = where?.id?.$in;
      const fields = (opts as { fields?: string[] } | undefined)?.fields;
      if (fields?.includes('teamSnapshot') && ids !== undefined) {
        snapshotReads.push(ids);
        return options.runs.filter((run) => ids.includes(run.id));
      }
      counts.listed += 1;
      reads.push({ where, options: opts });
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
    getByRunNode: async (runId: string, memberId: string) => {
      counts.nodeReads += 1;
      const kind = options.nodeAgents?.[`${runId}/${memberId}`];
      return kind === undefined
        ? null
        : ({ memberId, agentKind: kind } as NodeState);
    },
    listByRun: async (runId: string) => options.nodes[runId] ?? [],
    writePolledSpend: async (
      runId: string,
      memberId: string,
      spend: { ledger: string | null; cents: number; events: number },
    ) => {
      nodeWrites.push({ runId, memberId, ...spend });
    },
  } as unknown as NodeStateDao;

  const callReads: { runId: string; afterSeq: number }[] = [];
  const itemDao = {
    maxSeq: async (runId: string) => (options.calls?.[runId] ?? []).length,
    // Call `i` sits at seq `i + 1`.
    callResultSessions: async (
      runId: string,
      afterSeq: number,
      throughSeq: number,
    ) => {
      callReads.push({ runId, afterSeq });
      return (options.calls?.[runId] ?? []).slice(
        Math.max(afterSeq, 0),
        throughSeq,
      );
    },
  } as unknown as ItemDao;

  const bus = {
    all: () => ({
      subscribe: (fn: (event: ItemEvent) => void) => {
        onItem = fn;
        return { unsubscribe: () => undefined };
      },
    }),
    allDeleted: () => ({
      subscribe: (fn: (runId: string) => void) => {
        onDeleted = fn;
        return { unsubscribe: () => undefined };
      },
    }),
    publishRunStatus: (status: unknown) => published.push(status),
  } as unknown as AgentEventBus;

  const adapter = new MachineCursorAdapter(options.delegates);
  const service = new PolledSpendService(
    runDao,
    nodeStates,
    em,
    bus,
    new AgentAdapterRegistry([new ClaudeAdapter(), adapter]),
    itemDao,
    { writtenThrough: (_runId: string, maxSeq: number) => maxSeq } as never,
    { forRun: () => null } as unknown as ConfigDirPinService,
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
    snapshotReads,
    callReads,
    deleteRun: (runId) => onDeleted(runId),
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

/**
 * Answer each request by the login it carries: that account's events, a
 * refusal, or a throw. Records every request's login and window start.
 */
function answerPerAccount(
  replies: Record<string, unknown[] | 'refuse' | 'throw'>,
): { asked: { token: string; start: number }[] } {
  const asked: { token: string; start: number }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      const token = (
        new Headers(init?.headers).get('authorization') ?? ''
      ).replace(/^Bearer /, '');
      const body = JSON.parse(String(init?.body)) as { startDate: string };
      asked.push({ token, start: Number(body.startDate) });
      const reply = replies[token] ?? 'throw';
      if (reply === 'throw') {
        throw new Error('fetch failed');
      }
      if (reply === 'refuse') {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      return {
        ok: true,
        json: async () => ({
          usageEventsDisplay: reply,
          totalUsageEventsCount: reply.length,
        }),
      };
    }),
  );
  return { asked };
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
      { runId: 'run-1', memberId: 'node-0', cents: 488.8, events: 1 },
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
    // One figure per run filed a whole month of a team's cursor bill under
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

  it('starts the window at the oldest open boundary, and a new conversation where its member began', async () => {
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
            memberId: 'node-1',
            agentSessionId: 'conv-new',
            createdAt: new Date(NOW - 5 * HOUR),
          }),
        ],
      },
    });
    const { windows } = answerWith();

    await h.service.refresh(true);

    expect(windows).toEqual([{ start: settledAt, end: NOW }]);

    // Alone, the new conversation is asked about from an hour before its member.
    const fresh = harness({
      runs: [cursorRun()],
      nodes: {
        'run-1': [
          node({
            memberId: 'node-1',
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

  it('prices the conversations CALLERS held with a member, from its call records', async () => {
    // The $657 a real account billed to sixty-one call conversations whose
    // sessions are on no session history — runs older than that column — but on
    // the `call_result` row every call writes.
    at(NOW);
    const team = cursorRun({
      id: 'wf',
      agentKind: null,
      teamId: 'dev',
    });
    const h = harness({
      runs: [team],
      cursorNodeRunIds: ['wf'],
      nodes: {
        wf: [
          node({ runId: 'wf', memberId: 'qa' }),
          node({
            runId: 'wf',
            memberId: 'manager',
            agentKind: AgentKind.Claude,
          }),
        ],
      },
      calls: {
        wf: [
          { calleeMemberId: 'qa', sessionId: 'call-conv' },
          // A call to a member of another CLI names a session this account has
          // never heard of.
          { calleeMemberId: 'manager', sessionId: 'claude-conv' },
        ],
      },
    });
    answerWith(event('call-conv', 145.25), event('claude-conv', 999));

    await h.service.refresh(true);

    expect(h.nodeWrites).toMatchObject([{ memberId: 'qa', cents: 145.25 }]);
    expect(h.runWrites).toMatchObject([
      { id: 'wf', data: { polledCostCents: 145.25, polledCostEvents: 1 } },
    ]);
  });

  it('reads each run’s call results once, then only the rows written since', async () => {
    at(NOW);
    const calls = {
      wf: [{ calleeMemberId: 'qa', sessionId: 'call-conv' }],
    };
    const h = harness({
      runs: [
        cursorRun({
          id: 'wf',
          agentKind: null,
          teamId: 'dev',
          teamSnapshot: JSON.stringify({ nodes: [] }),
        }),
      ],
      cursorNodeRunIds: ['wf'],
      nodes: { wf: [node({ runId: 'wf', memberId: 'qa' })] },
      calls,
    });
    answerWith(event('call-conv', 10));

    await h.service.refresh(true);
    calls.wf.push({ calleeMemberId: 'qa', sessionId: 'later-conv' });
    await h.service.refresh(true);

    expect(h.callReads).toEqual([
      { runId: 'wf', afterSeq: -1 },
      { runId: 'wf', afterSeq: 1 },
    ]);
  });

  it('reads a long run’s call results in seq windows', async () => {
    at(NOW);
    const h = harness({
      runs: [
        cursorRun({
          id: 'wf',
          agentKind: null,
          teamId: 'dev',
          teamSnapshot: JSON.stringify({ nodes: [] }),
        }),
      ],
      cursorNodeRunIds: ['wf'],
      nodes: { wf: [node({ runId: 'wf', memberId: 'qa' })] },
      calls: {
        wf: Array.from({ length: 4_500 }, (_, n) => ({
          calleeMemberId: 'qa',
          sessionId: `conv-${n}`,
        })),
      },
    });
    answerWith(event('conv-0', 10));

    await h.service.refresh(true);

    expect(h.callReads.map((read) => read.afterSeq)).toEqual([
      -1, 1_999, 3_999,
    ]);
  });

  it('reads a deleted run’s call results afresh, should its id come back', async () => {
    at(NOW);
    const h = harness({
      runs: [
        cursorRun({
          id: 'wf',
          agentKind: null,
          teamId: 'dev',
          teamSnapshot: JSON.stringify({ nodes: [] }),
        }),
      ],
      cursorNodeRunIds: ['wf'],
      nodes: { wf: [node({ runId: 'wf', memberId: 'qa' })] },
      calls: { wf: [{ calleeMemberId: 'qa', sessionId: 'call-conv' }] },
    });
    answerWith(event('call-conv', 10));

    await h.service.refresh(true);
    h.deleteRun('wf');
    await h.service.refresh(true);

    expect(h.callReads.map((read) => read.afterSeq)).toEqual([-1, -1]);
  });

  it('prices every DELEGATE a conversation spawned, on the member that launched it', async () => {
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
      { memberId: 'node-0', cents: 142, events: 3 },
    ]);
  });

  it('starts a newly found delegate where its parent is still open, not where the member began', async () => {
    // On a chat weeks old, starting from the member would make every new delegate
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

  it('counts a conversation on ONE member, however many name it', async () => {
    // A delegate id can also turn up as a session another member resumed; billing
    // it to both would double the figure the user checks against their bill.
    at(NOW);
    const h = harness({
      runs: [cursorRun()],
      nodes: {
        'run-1': [
          holding('parent'),
          node({ memberId: 'node-1', agentSessionId: 'shared' }),
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

  it('prices a cursor member inside a TEAM, whose run names no agent', async () => {
    at(NOW);
    const team = cursorRun({
      id: 'wf',
      agentKind: null,
      teamId: 'dev',
    });
    const h = harness({
      runs: [team],
      cursorNodeRunIds: ['wf'],
      nodes: {
        wf: [node({ runId: 'wf', memberId: 'qa', agentSessionId: 'conv-wf' })],
      },
    });
    answerWith(event('conv-wf', 1_234.5));

    await h.service.refresh(true);

    expect(h.runWrites).toMatchObject([
      { id: 'wf', data: { polledCostCents: 1_234.5, polledCostEvents: 1 } },
    ]);
  });

  it('ignores a NON-cursor member of a run it reached through a cursor one', async () => {
    at(NOW);
    const team = cursorRun({
      id: 'wf',
      agentKind: null,
      teamId: 'dev',
    });
    const h = harness({
      runs: [team],
      cursorNodeRunIds: ['wf'],
      nodes: {
        wf: [
          node({
            runId: 'wf',
            memberId: 'engineer',
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
    const team = cursorRun({
      id: 'wf',
      agentKind: null,
      teamId: 'dev',
    });
    const h = harness({
      runs: [cursorRun(), team],
      cursorNodeRunIds: ['wf'],
      nodes: {
        'run-1': [holding('conv-1')],
        wf: [node({ runId: 'wf', memberId: 'qa', agentSessionId: 'conv-wf' })],
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
          'configDir',
          'cwd',
          'polledCostCents',
          'polledCostEvents',
          'polledSpendBuckets',
        ],
        disableIdentityMap: true,
      });
    }
    expect(h.snapshotReads).toEqual([['run-1', 'wf']]);
    expect(h.poolReads).toEqual([
      {
        where: { teamSnapshot: { $like: '%"agent":"cursor-agent"%' } },
        options: { fields: ['id'], disableIdentityMap: true },
      },
    ]);
  });

  it('matches every run’s team copy against the pooled CLI once, then only the runs created since', async () => {
    const move = at(NOW);
    const pooledCopy = JSON.stringify({
      nodes: [
        {
          id: 'eng',
          kind: 'agent',
          agent: 'claude',
          pool: [{ agent: 'cursor-agent' }],
        },
      ],
    });
    const runs = [
      cursorRun({
        id: 'old',
        agentKind: null,
        teamId: 'dev',
        teamSnapshot: pooledCopy,
        createdAt: new Date(NOW - 24 * HOUR),
      }),
    ];
    const h = harness({ runs, nodes: {} });

    await h.service.refresh(true);
    runs.push(
      cursorRun({
        id: 'new',
        agentKind: null,
        teamId: 'dev',
        teamSnapshot: pooledCopy,
        createdAt: new Date(NOW + HOUR),
      }),
    );
    move(NOW + 2 * HOUR);
    await h.service.refresh(true);

    expect(
      h.poolReads.map(
        (read) =>
          (read.where as { createdAt?: { $gte: Date } }).createdAt?.$gte,
      ),
    ).toEqual([undefined, new Date(NOW - 10 * 60_000)]);
    expect(h.reads.at(-1)?.where).toEqual({ id: { $in: ['old', 'new'] } });
  });

  it('finds an older run whose pooled team copy was frozen after the first read', async () => {
    const move = at(NOW);
    const old = cursorRun({
      id: 'old',
      agentKind: null,
      teamId: 'dev',
      teamSnapshot: null,
      createdAt: new Date(NOW - 90 * 24 * HOUR),
    });
    const h = harness({ runs: [old], nodes: {} });

    await h.service.refresh(true);
    old.teamSnapshot = JSON.stringify({
      nodes: [
        {
          id: 'eng',
          kind: 'agent',
          agent: 'claude',
          pool: [{ agent: 'cursor-agent' }],
        },
      ],
    });
    move(NOW + HOUR);
    await h.service.refresh(true);

    expect(h.reads.at(-1)?.where).toEqual({ id: { $in: ['old'] } });
  });

  it('parses a run’s team copy once, and keeps asking for a run that has none yet', async () => {
    at(NOW);
    const team = cursorRun({
      id: 'wf',
      agentKind: null,
      teamId: 'dev',
      teamSnapshot: JSON.stringify({ nodes: [] }),
    });
    const h = harness({
      runs: [cursorRun({ teamSnapshot: null }), team],
      cursorNodeRunIds: ['wf'],
      nodes: {
        'run-1': [holding('conv-1')],
        wf: [node({ runId: 'wf', memberId: 'qa', agentSessionId: 'conv-wf' })],
      },
    });
    answerWith(event('conv-1', 10), event('conv-wf', 20));

    await h.service.refresh(true);
    await h.service.refresh(true);

    expect(h.snapshotReads).toEqual([['run-1', 'wf'], ['run-1']]);
  });

  it('reads a deleted run’s team copy afresh, should its id come back', async () => {
    at(NOW);
    const h = harness({
      runs: [
        cursorRun({
          id: 'wf',
          agentKind: null,
          teamId: 'dev',
          teamSnapshot: JSON.stringify({ nodes: [] }),
        }),
      ],
      cursorNodeRunIds: ['wf'],
      nodes: {
        wf: [node({ runId: 'wf', memberId: 'qa', agentSessionId: 'conv-wf' })],
      },
    });
    answerWith(event('conv-wf', 20));

    await h.service.refresh(true);
    h.deleteRun('wf');
    await h.service.refresh(true);

    expect(h.snapshotReads).toEqual([['wf'], ['wf']]);
  });

  it('prices a POOLED member whose cursor pool member held a conversation, whatever its last turn was stamped', async () => {
    at(NOW);
    const team = cursorRun({
      id: 'wf',
      agentKind: null,
      teamId: 'dev',
      teamSnapshot: JSON.stringify({
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
      runs: [team],
      nodes: {
        wf: [
          node({
            runId: 'wf',
            memberId: 'eng',
            agentKind: AgentKind.Claude,
            agentSessionId: 'conv-cursor',
          }),
        ],
      },
    });
    answerWith(event('conv-cursor', 25));

    await h.service.refresh(true);

    expect(h.nodeWrites.map((write) => write.memberId)).toEqual(['eng']);
  });

  it('sums EVERY conversation a member held rather than keeping the last', async () => {
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

  it('polls on an item from a cursor NODE inside a team run, whose run row names no agent', async () => {
    const clock = at(NOW);
    const team = cursorRun({
      id: 'wf-1',
      agentKind: null,
      teamId: 'dev',
    });
    const h = harness({
      runs: [cursorRun(), team],
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

  it('asks again about a member that has not yet named its agent, rather than filing it as not cursor', async () => {
    const clock = at(NOW);
    const team = cursorRun({
      id: 'wf-1',
      agentKind: null,
      teamId: 'dev',
    });
    const nodeAgents: Record<string, AgentKind | null> = { 'wf-1/qa': null };
    const h = harness({
      runs: [cursorRun(), team],
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

  it('says a team run holds polled spend when any of its members ran on such a CLI', async () => {
    const h = harness({
      runs: [],
      nodes: { 'wf-1': [node({ runId: 'wf-1', memberId: 'qa' })] },
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

describe('PolledSpendService — whose account it asks', () => {
  const WORK = '/profiles/work';

  /** The latest ledger written for a member. */
  function ledgerWritten(
    h: Harness,
    runId: string,
    memberId: string,
  ): Map<string, ConversationSpend> {
    const write = h.nodeWrites
      .filter((w) => w.runId === runId && w.memberId === memberId)
      .at(-1);
    return readPolledSpendLedger(write?.ledger ?? null);
  }

  it('asks each conversation of the account of the profile it ran under, one request per account', async () => {
    at(NOW);
    const team = cursorRun({
      id: 'wf',
      agentKind: null,
      teamId: 'dev',
      teamSnapshot: JSON.stringify({
        members: [{ id: 'qa', agent: 'cursor-agent', configDir: WORK }],
      }),
    });
    const h = harness({
      runs: [cursorRun(), cursorRun({ id: 'run-2', configDir: WORK }), team],
      cursorNodeRunIds: ['wf'],
      nodes: {
        'run-1': [holding('conv-1')],
        'run-2': [holding('conv-2', { runId: 'run-2' })],
        wf: [node({ runId: 'wf', memberId: 'qa', agentSessionId: 'conv-wf' })],
      },
    });
    const { asked } = answerPerAccount({
      token: [event('conv-1', 10), event('conv-2', 999)],
      [`token:${WORK}`]: [event('conv-2', 20), event('conv-wf', 30)],
    });

    await h.service.refresh(true);

    expect(asked.map((ask) => ask.token).sort()).toEqual([
      'token',
      `token:${WORK}`,
    ]);
    expect(
      Object.fromEntries(
        h.runWrites.map((write) => [write.id, write.data.polledCostCents]),
      ),
    ).toEqual({ 'run-1': 10, 'run-2': 20, wf: 30 });
  });

  it('prices the accounts that answered when others refuse or throw, settling nothing of the failed ones', async () => {
    at(NOW);
    const createdAt = new Date(NOW - 3 * DAY);
    const unpriced = createdAt.getTime() - HOUR;
    const h = harness({
      runs: [
        cursorRun({ polledSpendBuckets: null }),
        cursorRun({ id: 'run-2', configDir: WORK, polledSpendBuckets: null }),
        cursorRun({
          id: 'run-3',
          configDir: SIGNED_OUT_PROFILE,
          polledSpendBuckets: null,
        }),
        cursorRun({
          id: 'run-4',
          configDir: '/profiles/refusing',
          polledSpendBuckets: null,
        }),
      ],
      nodes: {
        'run-1': [holding('conv-1', { createdAt })],
        'run-2': [holding('conv-2', { runId: 'run-2', createdAt })],
        'run-3': [holding('conv-3', { runId: 'run-3', createdAt })],
        'run-4': [holding('conv-4', { runId: 'run-4', createdAt })],
      },
    });
    const { asked } = answerPerAccount({
      token: [event('conv-1', 10, NOW - 2 * DAY)],
      [`token:${WORK}`]: 'throw',
      'token:/profiles/refusing': 'refuse',
    });

    await h.service.refresh(true);

    // The signed-out profile is never asked: no identity, no request.
    expect(asked.map((ask) => ask.token).sort()).toEqual([
      'token',
      'token:/profiles/refusing',
      `token:${WORK}`,
    ]);
    expect(h.runWrites.map((write) => write.id)).toEqual(['run-1']);
    expect(ledgerWritten(h, 'run-1', 'node-0').get('conv-1')).toMatchObject({
      settledThroughMs: NOW - DAY,
    });
    for (const [runId, conversationId] of [
      ['run-2', 'conv-2'],
      ['run-3', 'conv-3'],
      ['run-4', 'conv-4'],
    ] as const) {
      expect(
        ledgerWritten(h, runId, 'node-0').get(conversationId)?.settledThroughMs,
      ).toBe(unpriced);
    }
  });

  it('asks a pooled member of every cursor account in its pool, and settles it only once all of them read whole', async () => {
    const pooled = (): Run =>
      cursorRun({
        id: 'wf',
        agentKind: null,
        teamId: 'dev',
        teamSnapshot: JSON.stringify({
          members: [
            {
              id: 'eng',
              agent: 'cursor-agent',
              configDir: '/profiles/a',
              pool: [
                { agent: 'cursor-agent', configDir: '/profiles/b' },
                { agent: 'claude', configDir: '/profiles/c' },
              ],
            },
          ],
        }),
      });
    const nodes = {
      wf: [
        node({
          runId: 'wf',
          memberId: 'eng',
          agentSessionId: 'conv-p',
          createdAt: new Date(NOW - 3 * DAY),
        }),
      ],
    };
    const old = NOW - 2 * DAY;

    at(NOW);
    const both = harness({ runs: [pooled()], cursorNodeRunIds: ['wf'], nodes });
    const bothAsked = answerPerAccount({
      'token:/profiles/a': [event('conv-p', 5, old)],
      'token:/profiles/b': [event('conv-p', 7, NOW - HOUR)],
    });
    await both.service.refresh(true);

    // The pool's claude member is never asked of cursor's account.
    expect(bothAsked.asked.map((ask) => ask.token).sort()).toEqual([
      'token:/profiles/a',
      'token:/profiles/b',
    ]);
    expect(both.runWrites).toMatchObject([
      { id: 'wf', data: { polledCostCents: 12 } },
    ]);
    expect(ledgerWritten(both, 'wf', 'eng').get('conv-p')).toMatchObject({
      settledThroughMs: NOW - DAY,
      settled: { [spendBucket(old, 'grok-4.7')]: [5, 1] },
    });

    const one = harness({ runs: [pooled()], cursorNodeRunIds: ['wf'], nodes });
    answerPerAccount({
      'token:/profiles/a': [event('conv-p', 5, old)],
      'token:/profiles/b': 'refuse',
    });
    await one.service.refresh(true);

    expect(one.runWrites).toMatchObject([
      { id: 'wf', data: { polledCostCents: 5 } },
    ]);
    const open = ledgerWritten(one, 'wf', 'eng').get('conv-p');
    expect(open?.settled).toEqual({});
    expect(open?.open).toEqual({ [keyOf(old)]: [old, 5, 'grok-4.7'] });
  });

  it('prices again, from its member’s start, an empty entry the default account settled for a profile’s conversation', async () => {
    at(NOW);
    const createdAt = new Date(NOW - 3 * DAY);
    const charged = NOW - 2 * DAY;
    const h = harness({
      runs: [cursorRun({ id: 'run-2', configDir: WORK })],
      nodes: {
        'run-2': [
          holding('conv-2', {
            runId: 'run-2',
            createdAt,
            polledSpend: ledger({
              'conv-2': {
                settled: {},
                settledThroughMs: NOW - DAY,
                open: {},
              },
            }),
          }),
        ],
      },
    });
    const { asked } = answerPerAccount({
      token: [],
      [`token:${WORK}`]: [event('conv-2', 40, charged)],
    });

    await h.service.refresh(true);

    expect(asked.map((ask) => [ask.token, ask.start]).sort()).toEqual([
      ['token', createdAt.getTime() - HOUR],
      [`token:${WORK}`, createdAt.getTime() - HOUR],
    ]);
    expect(h.runWrites).toMatchObject([
      { id: 'run-2', data: { polledCostCents: 40 } },
    ]);
    expect(ledgerWritten(h, 'run-2', 'node-0').get('conv-2')).toMatchObject({
      settledThroughMs: NOW - DAY,
      settled: { [spendBucket(charged, 'grok-4.7')]: [40, 1] },
      accounts: [DEFAULT_ACCOUNT, WORK],
    });
  });

  it('settles a conversation past an account it was asked of that has no login, once another of its accounts read it whole', async () => {
    at(NOW);
    const createdAt = new Date(NOW - 3 * DAY);
    const charged = NOW - 2 * DAY;
    const h = harness({
      runs: [
        cursorRun({ configDir: WORK, polledSpendBuckets: null }),
        cursorRun({
          id: 'run-2',
          configDir: SIGNED_OUT_PROFILE,
          polledSpendBuckets: null,
        }),
      ],
      nodes: {
        'run-1': [
          holding('conv-1', {
            createdAt,
            polledSpend: ledger({
              'conv-1': {
                settled: {},
                settledThroughMs: NOW - DAY,
                open: {},
                accounts: [SIGNED_OUT_PROFILE],
              },
            }),
          }),
        ],
        'run-2': [holding('conv-2', { runId: 'run-2', createdAt })],
      },
    });
    answerPerAccount({ [`token:${WORK}`]: [event('conv-1', 7, charged)] });

    await h.service.refresh(true);

    // Moved off a signed-out profile: the profile it runs under now settles it.
    expect(ledgerWritten(h, 'run-1', 'node-0').get('conv-1')).toMatchObject({
      settledThroughMs: NOW - DAY,
      settled: { [spendBucket(charged, 'grok-4.7')]: [7, 1] },
    });
    // Asked of a signed-out profile alone: nothing read it, nothing settles.
    expect(
      ledgerWritten(h, 'run-2', 'node-0').get('conv-2')?.settledThroughMs,
    ).toBe(createdAt.getTime() - HOUR);
  });

  it('prices again, of the account it was asked of AND the one its chat runs under now, an empty entry from before a profile switch', async () => {
    at(NOW);
    const stored = ledger({
      'conv-1': {
        settled: {},
        settledThroughMs: NOW - HOUR,
        open: {},
        accounts: ['/profiles/old'],
      },
    });
    const h = harness({
      runs: [cursorRun({ configDir: WORK })],
      nodes: { 'run-1': [holding('conv-1', { polledSpend: stored })] },
    });
    const { asked } = answerPerAccount({
      'token:/profiles/old': [event('conv-1', 12, NOW - 2 * HOUR)],
      [`token:${WORK}`]: [],
    });

    await h.service.refresh(true);

    expect(asked.map((ask) => [ask.token, ask.start]).sort()).toEqual([
      ['token:/profiles/old', NOW - 3 * HOUR],
      [`token:${WORK}`, NOW - 3 * HOUR],
    ]);
    expect(h.runWrites).toMatchObject([
      { id: 'run-1', data: { polledCostCents: 12 } },
    ]);
    expect(ledgerWritten(h, 'run-1', 'node-0').get('conv-1')?.accounts).toEqual(
      ['/profiles/old', WORK],
    );
  });

  it('asks a delegate of the accounts its parent conversation was asked of', async () => {
    at(NOW);
    const h = harness({
      runs: [cursorRun({ configDir: WORK })],
      nodes: {
        'run-1': [
          holding('conv-new', {
            sessionIds: JSON.stringify(['conv-old']),
            polledSpend: ledger({
              'conv-old': {
                settled: {},
                settledThroughMs: NOW - 2 * HOUR,
                open: { [keyOf()]: [NOW - HOUR, 5, 'grok-4.7'] },
              },
            }),
          }),
        ],
      },
      delegates: { 'conv-old': ['child'] },
    });
    const { asked } = answerPerAccount({
      token: [event('child', 3)],
      [`token:${WORK}`]: [event('child', 999)],
    });

    await h.service.refresh(true);

    const written = ledgerWritten(h, 'run-1', 'node-0');
    expect(written.get('child')?.open).toEqual({
      [keyOf()]: [NOW - HOUR, 3, 'grok-4.7'],
    });
    expect(written.get('child')).not.toHaveProperty('accounts');
    expect(asked.map((ask) => ask.token).sort()).toEqual([
      'token',
      `token:${WORK}`,
    ]);
  });

  it('keeps an entry where it stands once it was asked of the member’s accounts, and one that found a charge wherever it was found', async () => {
    at(NOW);
    const h = harness({
      runs: [
        cursorRun(),
        cursorRun({ id: 'run-2', configDir: WORK }),
        cursorRun({ id: 'run-3', configDir: WORK, polledCostCents: 9 }),
      ],
      nodes: {
        'run-1': [
          holding('conv-1', {
            polledSpend: ledger({
              'conv-1': { settled: {}, settledThroughMs: NOW - HOUR, open: {} },
            }),
          }),
        ],
        'run-2': [
          holding('conv-2', {
            runId: 'run-2',
            polledSpend: ledger({
              'conv-2': {
                settled: {},
                settledThroughMs: NOW - 2 * HOUR,
                open: {},
                accounts: [WORK],
              },
            }),
          }),
        ],
        'run-3': [
          holding('conv-3', {
            runId: 'run-3',
            polledCostCents: 9,
            polledCostEvents: 1,
            polledSpend: ledger({
              'conv-3': {
                settled: { [spendBucket(NOW - 5 * HOUR, 'grok-4.7')]: [9, 1] },
                settledThroughMs: NOW - 4 * HOUR,
                open: {},
              },
            }),
          }),
        ],
      },
    });
    const { asked } = answerPerAccount({ token: [], [`token:${WORK}`]: [] });

    await h.service.refresh(true);

    // Each account from its OWN oldest open point: the default account for
    // conv-1 and for conv-3's charges, the work profile for conv-2 alone.
    expect(asked.map((ask) => [ask.token, ask.start]).sort()).toEqual([
      ['token', NOW - 4 * HOUR],
      [`token:${WORK}`, NOW - 2 * HOUR],
    ]);
  });

  it('keeps asking a chat’s earlier conversation of the account it ran on after the chat switched profile', async () => {
    at(NOW);
    const h = harness({
      runs: [cursorRun({ configDir: WORK })],
      nodes: {
        'run-1': [
          holding('conv-new', {
            sessionIds: JSON.stringify(['conv-old']),
            polledCostCents: 5,
            polledCostEvents: 1,
            polledSpend: ledger({
              'conv-old': {
                settled: {},
                settledThroughMs: NOW - 2 * HOUR,
                open: {
                  [keyOf(NOW - 90 * 60_000)]: [
                    NOW - 90 * 60_000,
                    5,
                    'grok-4.7',
                  ],
                },
              },
            }),
          }),
        ],
      },
    });
    const { asked } = answerPerAccount({
      token: [event('conv-old', 8, NOW - 90 * 60_000)],
      [`token:${WORK}`]: [event('conv-new', 30)],
    });

    await h.service.refresh(true);

    expect(asked.map((ask) => [ask.token, ask.start]).sort()).toEqual([
      ['token', NOW - 2 * HOUR],
      [`token:${WORK}`, NOW - 3 * HOUR],
    ]);
    expect(h.runWrites).toMatchObject([
      { id: 'run-1', data: { polledCostCents: 38 } },
    ]);
    const written = ledgerWritten(h, 'run-1', 'node-0');
    expect(written.get('conv-old')).not.toHaveProperty('accounts');
    expect(written.get('conv-new')?.accounts).toEqual([WORK]);
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
  function withAdapter(
    adapter: FakePolledAdapter,
    pinned: string | null = null,
  ) {
    const writes: Partial<Run>[] = [];
    const run = cursorRun({ agentKind: AgentKind.Claude, cwd: '/repo' });
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
            memberId: 'agent',
            agentKind: AgentKind.Claude,
            agentSessionId: 'sess-1',
          }),
        ],
        writePolledSpend: async () => undefined,
      } as unknown as NodeStateDao,
      em,
      { publishRunStatus: () => undefined } as unknown as AgentEventBus,
      new AgentAdapterRegistry([adapter]),
      {
        maxSeq: async () => -1,
        callResultSessions: async () => [],
      } as unknown as ItemDao,
      { writtenThrough: (_runId: string, maxSeq: number) => maxSeq } as never,
      {
        forRun: (_kind: AgentKind, cwd: string | null) =>
          pinned === null || cwd !== run.cwd ? null : { effective: pinned },
      } as unknown as ConfigDirPinService,
    );
    return { service, writes };
  }

  it('asks the account the run’s FOLDER pins, when its CLI pins one', async () => {
    at(NOW);
    const adapter = new FakePolledAdapter(true, { complete: true, events: [] });
    const { service } = withAdapter(adapter, '/profiles/pinned');

    await service.refresh(true);

    expect(adapter.queries.map((query) => query.configDir)).toEqual([
      '/profiles/pinned',
    ]);
  });

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

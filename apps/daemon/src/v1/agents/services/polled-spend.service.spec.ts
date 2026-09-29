import type { EntityManager } from '@mikro-orm/sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NodeState } from '../../runs/entity/node-state.entity';
import type { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import { freshVocabularyStore } from '../adapters/__tests__/fresh-vocabulary-store';
import type {
  AccountSpendConversation,
  AccountSpendQuery,
  AdapterConfig,
} from '../adapters/adapter.types';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';
import type { NodeStateDao } from '../dao/node-state.dao';
import type { RunDao } from '../dao/run.dao';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import type { AgentEventBus } from './agent-events.bus';
import { PolledSpendService } from './polled-spend.service';

const em = { fork: () => em } as unknown as EntityManager;

/**
 * The REAL cursor adapter with its MACHINE stood in for — the Keychain read and
 * the CLI's identity file, the only two things a poll needs from this computer.
 * Everything else (the request, the fold, the write, the announce) is the real
 * implementation, so these cases also pin the adapter's half of the poll.
 */
class MachineCursorAdapter extends CursorAcpAdapter {
  constructor() {
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

/** The slice of an `AgentEventBus` item event the service reads. */
interface ItemEvent {
  runId: string;
  item: { nodeId: string | null };
}

/** An item landing on `runId`, from its main thread or from one node. */
function itemOn(runId: string, nodeId: string | null = null): ItemEvent {
  return { runId, item: { nodeId } };
}

function deps(
  runs: Run[],
  /**
   * One entry per node: its session id, or — for a node that held several
   * conversations — its whole session history, the LAST being the one it
   * would resume (`agentSessionId`).
   */
  sessionsByRun: Record<string, (string | string[])[]>,
  /** Per-conversation watermark, keyed by session id. Absent = never priced. */
  watermarks: Record<string, number> = {},
  /**
   * Runs found through a cursor NODE rather than through their own agent —
   * i.e. workflows. Their `node_state` rows are stamped `cursor-agent`, which
   * is what the service filters on once a run row names no agent.
   */
  cursorNodeRunIds: string[] = [],
  /** A workflow node's own agent, keyed `<runId>/<nodeId>` — what its row says. */
  nodeAgents: Record<string, AgentKind | null> = {},
): {
  service: PolledSpendService;
  writes: { id: string; data: Partial<Run> }[];
  marks: {
    runId: string;
    nodeId: string;
    conversationId: string;
    throughMs: number;
  }[];
  nodeSpend: {
    runId: string;
    nodeId: string;
    cents: number;
    events: number;
  }[];
  published: unknown[];
  onItem: (event: ItemEvent) => void;
  counts: { listed: number; nodeReads: number };
  /** Every run listing the service made, with the options it asked with. */
  reads: { where: unknown; options: unknown }[];
} {
  const writes: { id: string; data: Partial<Run> }[] = [];
  const marks: {
    runId: string;
    nodeId: string;
    conversationId: string;
    throughMs: number;
  }[] = [];
  const nodeSpend: {
    runId: string;
    nodeId: string;
    cents: number;
    events: number;
  }[] = [];
  const published: unknown[] = [];
  const counts = { listed: 0, nodeReads: 0 };
  const reads: { where: unknown; options: unknown }[] = [];
  let onItem: (event: ItemEvent) => void = () => undefined;

  const runDao = {
    // Honours the FILTER, because the service now makes two different reads:
    // the 1:1 cursor chats, and then the runs merely holding a cursor node,
    // which it addresses by id. A double that ignored the filter answered the
    // cursor runs twice and counted every conversation of theirs twice with it.
    getAll: async (
      where?: {
        id?: { $in?: string[] };
        agentKind?: AgentKind;
      },
      options?: unknown,
    ) => {
      counts.listed += 1;
      reads.push({ where, options });
      const ids = where?.id?.$in;
      if (ids !== undefined) {
        return runs.filter((run) => ids.includes(run.id));
      }
      return runs.filter((run) => run.agentKind === where?.agentKind);
    },
    getById: async (id: string) => runs.find((run) => run.id === id) ?? null,
    updateWithoutActivity: async (id: string, data: Partial<Run>) => {
      writes.push({ id, data });
      return 1;
    },
  } as unknown as RunDao;

  const nodeStates = {
    /**
     * Which runs hold a node that RAN on an agent — how a workflow's cursor
     * node is found, its run row naming no agent of its own.
     *
     * These fixtures are all 1:1 chats, so the honest answer is none: every
     * case below is reached through `Run.agentKind`, exactly as before.
     */
    runIdsForAgent: async () => cursorNodeRunIds,
    getByRunNode: async (runId: string, nodeId: string) => {
      counts.nodeReads += 1;
      const kind = nodeAgents[`${runId}/${nodeId}`];
      return kind === undefined
        ? null
        : ({ nodeId, agentKind: kind } as NodeState);
    },
    listByRun: async (runId: string) =>
      (sessionsByRun[runId] ?? []).map((sessions, index) => {
        const history = typeof sessions === 'string' ? [sessions] : sessions;
        const held = Object.fromEntries(
          history
            .filter((id) => watermarks[id] !== undefined)
            .map((id) => [id, watermarks[id]]),
        );
        return {
          agentSessionId: history[history.length - 1] ?? null,
          sessionIds:
            typeof sessions === 'string' ? null : JSON.stringify(history),
          nodeId: `node-${index}`,
          agentKind: cursorNodeRunIds.includes(runId)
            ? AgentKind.CursorAgent
            : null,
          polledSpendThrough:
            Object.keys(held).length === 0 ? null : JSON.stringify(held),
        } as NodeState;
      }),
    addPolledSpend: async (
      runId: string,
      nodeId: string,
      delta: { cents: number; events: number },
    ) => {
      nodeSpend.push({ runId, nodeId, ...delta });
    },
    rememberPolledSpendThrough: async (
      runId: string,
      nodeId: string,
      conversationId: string,
      throughMs: number,
    ) => {
      marks.push({ runId, nodeId, conversationId, throughMs });
    },
  } as unknown as NodeStateDao;

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

  const service = new PolledSpendService(
    runDao,
    nodeStates,
    em,
    bus,
    new AgentAdapterRegistry([new ClaudeAdapter(), new MachineCursorAdapter()]),
  );
  service.onModuleInit();
  return {
    service,
    writes,
    marks,
    nodeSpend,
    published,
    onItem: (event) => onItem(event),
    counts,
    reads,
  };
}

const EVENT_AT_MS = 1_788_358_173_608;

function event(
  conversationId: string,
  chargedCents: number,
  atMs: number = EVENT_AT_MS,
): unknown {
  return {
    conversationId,
    chargedCents,
    isChargeable: true,
    timestamp: String(atMs),
  };
}

/** One page of usage events, as Cursor's endpoint answers it. */
function answerWith(...events: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        usageEventsDisplay: events,
        totalUsageEventsCount: events.length,
      }),
    })),
  );
}

/** Let the bus subscriber's own async work settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Pin the clock, and return the way to move it.
 *
 * `Date.now` rather than fake timers: the floors are the whole subject here and
 * {@link flush} needs a real `setTimeout` to let the subscriber's promises land.
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
  it('announces a run whose fetched spend changed', async () => {
    const run = cursorRun();
    const { service, writes, published } = deps([run], {
      'run-1': ['conv-1'],
    });
    answerWith(event('conv-1', 488.8));

    await service.refresh(true);

    expect(writes).toEqual([
      { id: 'run-1', data: { polledCostCents: 488.8, polledCostEvents: 1 } },
    ]);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ runId: 'run-1', status: null });
    expect(
      (published[0] as { spendUpdatedAt: number }).spendUpdatedAt,
    ).toBeGreaterThan(0);
  });

  it('prices a cursor node inside a WORKFLOW, whose run names no agent', async () => {
    // The reported wrong figure. A workflow run's `agentKind` is null — its
    // agents are per node — so selecting runs on that column skipped every
    // workflow, however much cursor work it did. Measured on a real profile: a
    // `dev-team` run whose QA node worked an hour on cursor with 160 tool calls
    // was priced at nothing, and geniro reported $2.05 of cursor spend for a
    // morning the user's own Cursor dashboard showed far more for.
    const workflow = cursorRun({
      id: 'run-wf',
      agentKind: null,
      workflowId: 'dev-team',
    });
    const { service, writes } = deps(
      [workflow],
      { 'run-wf': ['conv-wf'] },
      {},
      ['run-wf'],
    );
    answerWith(event('conv-wf', 1_234.5));

    await service.refresh(true);

    expect(writes).toEqual([
      { id: 'run-wf', data: { polledCostCents: 1_234.5, polledCostEvents: 1 } },
    ]);
  });

  it('reads only the run columns a poll uses, past the identity map, on both of its run listings', async () => {
    // A poll needs four fields of each run and writes through a native update,
    // so the rest of the row — every text column, for every run of the CLI — is
    // loaded for nothing. There are two listings: the chats found by their own
    // agent, and the runs reached only through one of their nodes.
    const workflow = cursorRun({
      id: 'run-wf',
      agentKind: null,
      workflowId: 'dev-team',
    });
    const { service, reads } = deps(
      [cursorRun(), workflow],
      { 'run-1': ['conv-1'], 'run-wf': ['conv-wf'] },
      {},
      ['run-wf'],
    );
    answerWith(event('conv-1', 10), event('conv-wf', 20));

    await service.refresh(true);

    expect(reads.map((read) => read.where)).toEqual([
      { agentKind: AgentKind.CursorAgent },
      { id: { $in: ['run-wf'] } },
    ]);
    for (const read of reads) {
      expect(
        read.options,
        `the options of the listing ${JSON.stringify(read.where)}`,
      ).toEqual({
        fields: ['id', 'agentKind', 'polledCostCents', 'polledCostEvents'],
        disableIdentityMap: true,
      });
    }
  });

  it('ignores a NON-cursor node of a run it reached through a cursor one', async () => {
    // A workflow routes work to several CLIs, and only the cursor nodes hold a
    // Cursor conversation. A claude node's session id belongs to that CLI's own
    // store — offering it here would ask Cursor to price a conversation it has
    // never heard of, and any match would be a coincidence of id shape.
    const workflow = cursorRun({
      id: 'run-wf',
      agentKind: null,
      workflowId: 'dev-team',
    });
    // `cursorNodeRunIds` is empty, so every node this run reports is stamped
    // with no agent — the shape of a run reached in error.
    const { service, writes } = deps([workflow], { 'run-wf': ['conv-wf'] });
    answerWith(event('conv-wf', 999));

    await service.refresh(true);

    expect(writes).toEqual([]);
  });

  it('says nothing about a run whose charges were all counted already', async () => {
    // A poll covers every polled conversation on the machine, so announcing
    // each one would put an event per thread on the wire every minute to say
    // that nothing had changed.
    const run = cursorRun({ polledCostCents: 488.8, polledCostEvents: 1 });
    const { service, writes, published } = deps(
      [run],
      { 'run-1': ['conv-1'] },
      { 'conv-1': EVENT_AT_MS },
    );
    answerWith(event('conv-1', 488.8));

    await service.refresh(true);

    expect(writes).toEqual([]);
    expect(published).toEqual([]);
  });

  it('sums every conversation a run holds rather than keeping the last', async () => {
    const run = cursorRun();
    const { service, writes } = deps([run], {
      'run-1': ['conv-1', 'conv-2'],
    });
    answerWith(event('conv-1', 100), event('conv-2', 25));

    await service.refresh(true);

    expect(writes).toEqual([
      { id: 'run-1', data: { polledCostCents: 125, polledCostEvents: 2 } },
    ]);
  });

  it('polls a minute after a cursor item, well inside the ambient floor', async () => {
    const clock = at(1_000_000);
    const { service, counts, onItem } = deps([cursorRun()], {
      'run-1': ['conv-1'],
    });
    answerWith(event('conv-1', 10));
    await service.refresh(true);
    expect(counts.listed).toBe(1);

    // Half a minute on: too soon even for the live floor.
    clock(1_030_000);
    onItem(itemOn('run-1'));
    await flush();
    expect(counts.listed).toBe(1);

    // Ninety seconds on: past the live floor, and nowhere near the ten-minute
    // one the ambient trigger waits for.
    clock(1_090_000);
    onItem(itemOn('run-1'));
    await flush();
    expect(counts.listed).toBe(2);
  });

  it('ADDS what is new, so a thread billed for longer than the window never shrinks', async () => {
    // The window is ~61 minutes wide, so a conversation billed for longer than
    // that used to have its whole recorded total overwritten by the recent
    // slice — the displayed cost visibly ticking downward. Written as an add
    // over the watermark, the earlier spend survives.
    const run = cursorRun({ polledCostCents: 500, polledCostEvents: 5 });
    const { service, writes } = deps(
      [run],
      { 'run-1': ['conv-1'] },
      { 'conv-1': EVENT_AT_MS - 1_000 },
    );
    answerWith(event('conv-1', 20));

    await service.refresh(true);

    expect(writes).toEqual([
      { id: 'run-1', data: { polledCostCents: 520, polledCostEvents: 6 } },
    ]);
  });

  it('counts an event the overlapping window re-reads exactly once', async () => {
    const run = cursorRun({ polledCostCents: 500, polledCostEvents: 5 });
    const { service, writes } = deps(
      [run],
      { 'run-1': ['conv-1'] },
      { 'conv-1': EVENT_AT_MS },
    );
    answerWith(event('conv-1', 20));

    await service.refresh(true);

    expect(writes).toEqual([]);
  });

  it('files each conversation’s price on its NODE as well as the run', async () => {
    // A workflow mixes CLIs, so the run's figure cannot say what its cursor node
    // cost; the node's own share is what its agent card states.
    const { service, nodeSpend } = deps([cursorRun()], { 'run-1': ['conv-1'] });
    answerWith(event('conv-1', 40), event('conv-1', 60, EVENT_AT_MS + 1_000));

    await service.refresh(true);

    expect(nodeSpend).toEqual([
      { runId: 'run-1', nodeId: 'node-0', cents: 100, events: 2 },
    ]);
  });

  // One node holds a conversation per call to it, and a compaction replaces
  // one — while `agentSessionId` names only the latest. Pricing that alone left
  // every earlier conversation unpriced, and one shared mark would drop an
  // older conversation's late-billed events behind the newer one's.
  it('prices EVERY conversation a node held, each against its OWN mark', async () => {
    const run = cursorRun({ polledCostCents: 500, polledCostEvents: 5 });
    const { service, writes, marks } = deps(
      [run],
      { 'run-1': [['conv-old', 'conv-new']] },
      // The older conversation was priced a while ago; the newer one is priced
      // PAST this event — so only the older one's late bill is new.
      { 'conv-old': EVENT_AT_MS - 10_000, 'conv-new': EVENT_AT_MS + 60_000 },
    );
    answerWith(event('conv-old', 30), event('conv-new', 99));

    await service.refresh(true);

    expect(writes).toEqual([
      { id: 'run-1', data: { polledCostCents: 530, polledCostEvents: 6 } },
    ]);
    expect(marks).toEqual([
      {
        runId: 'run-1',
        nodeId: 'node-0',
        conversationId: 'conv-old',
        throughMs: EVENT_AT_MS,
      },
    ]);
  });

  it('advances the watermark to the newest event it counted', async () => {
    const { service, marks } = deps([cursorRun()], { 'run-1': ['conv-1'] });
    answerWith(
      event('conv-1', 10, EVENT_AT_MS),
      event('conv-1', 15, EVENT_AT_MS + 5_000),
    );

    await service.refresh(true);

    expect(marks).toEqual([
      {
        runId: 'run-1',
        nodeId: 'node-0',
        conversationId: 'conv-1',
        throughMs: EVENT_AT_MS + 5_000,
      },
    ]);
  });

  it('watermarks a conversation whose events carried NO readable timestamp', async () => {
    // Left unmarked, such a conversation is re-counted on every later poll and
    // the total climbs without bound on a figure the user checks against their
    // own bill. Marked at the poll's own end, it is counted once.
    at(1_000_000);
    const { service, marks } = deps([cursorRun()], { 'run-1': ['conv-1'] });
    answerWith({
      conversationId: 'conv-1',
      chargedCents: 10,
      isChargeable: true,
      // no `timestamp` at all — the shape the fold cannot place
    });

    await service.refresh(true);

    expect(marks).toEqual([
      {
        runId: 'run-1',
        nodeId: 'node-0',
        conversationId: 'conv-1',
        throughMs: 1_000_000,
      },
    ]);
  });

  it('re-counts nothing on the poll after that watermark', async () => {
    at(2_000_000);
    const run = cursorRun({ polledCostCents: 10, polledCostEvents: 1 });
    const { service, writes } = deps(
      [run],
      { 'run-1': ['conv-1'] },
      { 'conv-1': 1_000_000 },
    );
    answerWith({
      conversationId: 'conv-1',
      chargedCents: 10,
      isChargeable: true,
    });

    await service.refresh(true);

    expect(writes).toEqual([]);
  });

  it('does not poll on an item from a run of another CLI', async () => {
    const clock = at(1_000_000);
    const { service, counts, onItem } = deps(
      [cursorRun(), cursorRun({ id: 'run-2', agentKind: AgentKind.Claude })],
      { 'run-1': ['conv-1'] },
    );
    answerWith(event('conv-1', 10));
    await service.refresh(true);
    expect(counts.listed).toBe(1);

    clock(1_090_000);
    onItem(itemOn('run-2'));
    await flush();

    expect(counts.listed).toBe(1);
  });

  it('polls on an item from a cursor NODE inside a workflow run, whose run row names no agent', async () => {
    // The reported case: a Dev Team run's QA node on cursor worked ~90 minutes
    // and nothing polled, because the live trigger asked only the RUN's agent.
    const clock = at(1_000_000);
    const workflow = cursorRun({
      id: 'wf-1',
      agentKind: null,
      workflowId: 'dev-team',
    });
    const { service, counts, onItem } = deps(
      [cursorRun(), workflow],
      { 'run-1': ['conv-1'] },
      {},
      [],
      { 'wf-1/qa': AgentKind.CursorAgent, 'wf-1/engineer': AgentKind.Claude },
    );
    answerWith(event('conv-1', 10));
    await service.refresh(true);
    expect(counts.listed).toBe(1);

    clock(1_090_000);
    onItem(itemOn('wf-1', 'engineer'));
    await flush();
    expect(counts.listed).toBe(1);

    onItem(itemOn('wf-1', 'qa'));
    await flush();
    expect(counts.listed).toBe(2);
  });

  it('asks again about a node that has not yet named its agent, rather than filing it as not cursor', async () => {
    const clock = at(1_000_000);
    const workflow = cursorRun({
      id: 'wf-1',
      agentKind: null,
      workflowId: 'dev-team',
    });
    const nodeAgents: Record<string, AgentKind | null> = { 'wf-1/qa': null };
    const { service, counts, onItem } = deps(
      [cursorRun(), workflow],
      { 'run-1': ['conv-1'] },
      {},
      [],
      nodeAgents,
    );
    answerWith(event('conv-1', 10));
    await service.refresh(true);

    clock(1_090_000);
    onItem(itemOn('wf-1', 'qa'));
    await flush();
    expect(counts.listed).toBe(1);

    // The node's turn has started: its row now names cursor.
    nodeAgents['wf-1/qa'] = AgentKind.CursorAgent;
    onItem(itemOn('wf-1', 'qa'));
    await flush();
    expect(counts.nodeReads).toBe(2);
    expect(counts.listed).toBe(2);
  });

  it('says a workflow run holds polled spend when any of its nodes ran on such a CLI', async () => {
    const { service } = deps([], { 'wf-1': ['conv-9'] }, {}, ['wf-1']);
    expect(await service.runHoldsPolledSpend('wf-1', null)).toBe(true);
    expect(await service.runHoldsPolledSpend('wf-2', null)).toBe(false);
    expect(
      await service.runHoldsPolledSpend('chat-1', AgentKind.CursorAgent),
    ).toBe(true);
    expect(await service.runHoldsPolledSpend('chat-2', AgentKind.Claude)).toBe(
      false,
    );
  });
});

/** A CLI that declares polled spend and answers with whatever it is handed. */
class FakePolledAdapter extends ClaudeAdapter {
  readonly queries: AccountSpendQuery[] = [];

  constructor(
    private readonly polls: boolean,
    private readonly answer: Map<string, AccountSpendConversation> | null,
  ) {
    super();
  }

  override getConfig(): AdapterConfig {
    const base = super.getConfig();
    return { ...base, usage: { ...base.usage, polledSpend: this.polls } };
  }

  override async fetchAccountSpend(
    query: AccountSpendQuery,
  ): Promise<Map<string, AccountSpendConversation> | null> {
    this.queries.push(query);
    return this.answer;
  }
}

describe('PolledSpendService — which CLIs it asks', () => {
  function withAdapter(adapter: FakePolledAdapter, run: Run) {
    const writes: Partial<Run>[] = [];
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
          {
            nodeId: 'agent',
            agentKind: run.agentKind,
            agentSessionId: 'sess-1',
            polledSpendThrough: null,
          } as unknown as NodeState,
        ],
        rememberPolledSpendThrough: async () => undefined,
        addPolledSpend: async () => undefined,
      } as unknown as NodeStateDao,
      em,
      {
        publishRunStatus: () => undefined,
      } as unknown as AgentEventBus,
      new AgentAdapterRegistry([adapter]),
    );
    return { service, writes };
  }

  it('asks a polled CLI’s OWN adapter, with every conversation’s watermark', async () => {
    const adapter = new FakePolledAdapter(
      true,
      new Map([
        [
          'sess-1',
          {
            conversationId: 'sess-1',
            costCents: 250,
            events: 2,
            latestAtMs: EVENT_AT_MS,
          },
        ],
      ]),
    );
    const { service, writes } = withAdapter(
      adapter,
      cursorRun({ agentKind: AgentKind.Claude }),
    );

    await service.refresh(true);

    expect(adapter.queries).toHaveLength(1);
    expect([...adapter.queries[0]!.since]).toEqual([['sess-1', 0]]);
    expect(writes).toEqual([{ polledCostCents: 250, polledCostEvents: 2 }]);
  });

  it('never asks a CLI whose turns price themselves', async () => {
    const adapter = new FakePolledAdapter(false, new Map());
    const { service } = withAdapter(
      adapter,
      cursorRun({ agentKind: AgentKind.Claude }),
    );

    await service.refresh(true);

    expect(adapter.queries).toHaveLength(0);
  });

  it('writes nothing when the account could not be read', async () => {
    // Null is "no cost reported", never an error and never a zero.
    const adapter = new FakePolledAdapter(true, null);
    const { service, writes } = withAdapter(
      adapter,
      cursorRun({ agentKind: AgentKind.Claude }),
    );

    await service.refresh(true);

    expect(adapter.queries).toHaveLength(1);
    expect(writes).toEqual([]);
  });
});

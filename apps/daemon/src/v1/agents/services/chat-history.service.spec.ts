import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import type { ItemKind } from '../../runs/runs.types';
import { kindRowsPassthrough } from '../__tests__/kind-rows-passthrough';
import type { ItemWire } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { itemToWire } from '../utils/item-wire';
import type { ChatService } from './chat.service';
import { ChatHistoryService } from './chat-history.service';
import { ItemCallIndexService } from './item-call-index.service';

/**
 * Real-driver spec, on `item.dao.spec.ts`'s pattern: the anchor reads include a
 * raw `json_extract` filter, which only a real SQLite can say is right.
 */
describe('ChatHistoryService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: ItemDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Run, Item, NodeState],
        ignoreUndefinedInQuery: true,
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    dao = new ItemDao(orm.em.fork());
  });

  async function insert(
    seq: number,
    kind: ItemKind,
    payload: unknown,
    runId = 'run-a',
  ): Promise<Item> {
    return dao.create({ runId, seq, kind, payload: JSON.stringify(payload) });
  }

  /** The service over the real DAO; `page` is what `getHistory` would answer. */
  function service(page: readonly ItemWire[] = []): ChatHistoryService {
    const chats = {
      getHistory: () => Promise.resolve([...page]),
    } as unknown as ChatService;
    return new ChatHistoryService(
      orm.em,
      dao,
      chats,
      callIndex(),
      kindRowsPassthrough(dao),
    );
  }

  function callIndex(): ItemCallIndexService {
    return new ItemCallIndexService(dao, new RunDao(orm.em.fork()), orm.em);
  }

  /** The service with `getHistory` reading the real DAO, as `ChatService`'s does. */
  function readingService(): ChatHistoryService {
    const chats = {
      getHistory: async (
        runId: string,
        afterSeq: number,
        window: Parameters<ItemDao['getByRun']>[3],
        inCalls: readonly string[] | undefined,
      ) =>
        (
          await dao.getByRun(runId, afterSeq, orm.em.fork(), window, inCalls)
        ).map(itemToWire),
    } as unknown as ChatService;
    return new ChatHistoryService(
      orm.em,
      dao,
      chats,
      callIndex(),
      kindRowsPassthrough(dao),
    );
  }

  it('serves a tool result’s base64 image as a line naming it, on the page and among its anchors', async () => {
    const screenshot = {
      id: 't1',
      result: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'A'.repeat(4_096),
          },
        },
      ],
    };
    await insert(1, 'tool_call', { id: 't1', name: 'screenshot' });
    await insert(2, 'tool_result', screenshot);
    const served = '[image: image/png, 3 KB]';

    const page = await readingService().read('run-a', -1, {
      limit: 1,
      take: 'newest',
    });
    const anchored = await readingService().read('run-a', -1, {
      limit: 1,
      take: 'oldest',
    });

    expect(page.items.map((row) => row.payload)).toEqual([
      { id: 't1', result: [served] },
    ]);
    expect(
      anchored.anchors
        .filter((row) => row.kind === 'tool_result')
        .map((row) => row.payload),
    ).toEqual([{ id: 't1', result: [served] }]);
    expect(JSON.parse((await dao.getByRun('run-a', -1))[1]!.payload)).toEqual(
      screenshot,
    );
  });

  describe('one conversation of a workflow run', () => {
    async function workflowRun(): Promise<void> {
      await new RunDao(orm.em.fork()).create({
        id: 'run-a',
        workflowId: 'dev-team',
      });
      await dao.create({
        runId: 'run-a',
        seq: 1,
        kind: 'message',
        nodeId: 'manager',
        payload: JSON.stringify({ text: 'splitting the work' }),
      });
      await dao.create({
        runId: 'run-a',
        seq: 2,
        kind: 'call_started',
        nodeId: 'manager',
        payload: JSON.stringify({ callId: 'call-1', calleeNodeId: 'eng' }),
      });
      await dao.create({
        runId: 'run-a',
        seq: 3,
        kind: 'tool_call',
        nodeId: 'eng',
        payload: JSON.stringify({ id: 't1', callId: 'call-1' }),
      });
      await dao.create({
        runId: 'run-a',
        seq: 4,
        kind: 'approval_request',
        nodeId: 'eng',
        payload: JSON.stringify({ callId: 'call-1', requestId: 'r1' }),
      });
      await dao.create({
        runId: 'run-a',
        seq: 5,
        kind: 'call_started',
        nodeId: 'manager',
        payload: JSON.stringify({ callId: 'call-2', calleeNodeId: 'qa' }),
      });
      await dao.create({
        runId: 'run-a',
        seq: 6,
        kind: 'message',
        nodeId: 'qa',
        payload: JSON.stringify({ text: 'checked', callId: 'call-2' }),
      });
      await dao.create({
        runId: 'run-a',
        seq: 7,
        kind: 'call_started',
        nodeId: 'manager',
        payload: JSON.stringify({
          callId: 'call-3',
          calleeNodeId: 'eng',
          thread: 'call-1',
        }),
      });
      await dao.create({
        runId: 'run-a',
        seq: 8,
        kind: 'message',
        nodeId: 'eng',
        payload: JSON.stringify({ text: 'continued', callId: 'call-3' }),
      });
    }

    it("reads the run's own flow — its turns, every call's start and the card a person answers — and no callee's rows", async () => {
      await workflowRun();

      const { items } = await readingService().read(
        'run-a',
        -1,
        { limit: 50 },
        { root: true },
      );

      expect(items.map((item) => item.seq)).toEqual([1, 2, 4, 5, 7]);
    });

    it("reads a call's conversation, its continuation included, and no other call's", async () => {
      await workflowRun();

      const { items } = await readingService().read(
        'run-a',
        -1,
        { limit: 50 },
        { call: 'call-3' },
      );

      expect(items.map((item) => item.seq)).toEqual([3, 8]);
    });

    it("anchors each call card's readings to a page of the run's own flow — and nothing only an opened card draws", async () => {
      await workflowRun();
      const row = (
        seq: number,
        kind: ItemKind,
        nodeId: string,
        payload: unknown,
        role: string | null = null,
      ) =>
        dao.create({
          runId: 'run-a',
          seq,
          kind,
          nodeId,
          role,
          payload: JSON.stringify(payload),
        });
      await row(9, 'status', 'qa', { callId: 'call-2', status: 'running' });
      await row(10, 'tool_call', 'qa', {
        id: 't2',
        name: 'Bash',
        callId: 'call-2',
      });
      await row(11, 'tool_result', 'qa', { id: 't2', callId: 'call-2' });
      await row(12, 'message', 'qa', { text: 'all green', callId: 'call-2' });
      await row(13, 'task_list', 'qa', { callId: 'call-2', tasks: [] });
      // Newer than the readings a folded card shows, and saying nothing: an
      // ACP tool call naming no tool, and a blank message.
      await row(20, 'tool_call', 'qa', { id: 't3', callId: 'call-2' });
      // Blank in every way the renderer's `String.trim` reads one.
      await row(21, 'message', 'qa', { text: '\n\t\n', callId: 'call-2' });
      await row(22, 'system', 'qa', {
        callId: 'call-2',
        heldCall: true,
        waitingOn: 1,
      });
      await row(23, 'reasoning', 'qa', { callId: 'call-2', text: 'still' });
      await row(14, 'status', 'qa', { callId: 'call-2', status: 'completed' });
      await row(15, 'call_result', 'manager', {
        callId: 'call-2',
        status: 'ok',
      });
      await row(16, 'turn_complete', 'qa', { callId: 'call-2' });
      // The callee carrying on after the call settled: its newest row.
      await row(17, 'reasoning', 'qa', { callId: 'call-2', text: 'hmm' });
      // A person writing to the callee is never its newest words or row.
      await row(
        18,
        'message',
        'qa',
        { text: 'ping', callId: 'call-2' },
        'user',
      );
      await row(19, 'message', 'manager', { text: 'qa is done' });

      const { items, anchors } = await readingService().read(
        'run-a',
        -1,
        { limit: 50 },
        { root: true },
      );

      expect(items.map((item) => item.seq)).toEqual([1, 2, 4, 5, 7, 19]);
      const qa = anchors
        .filter(
          (item) =>
            item.payload !== null &&
            (item.payload as { callId?: string }).callId === 'call-2',
        )
        .map((item) => item.seq);
      // Statuses, task list, turn end, notice and settle; the newest NAMED tool
      // call and its reply, the newest words and the newest row. Never its
      // older words, the user's message or the rows that say nothing.
      expect(qa).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 22, 23]);
    });

    it('anchors older named tool calls too, for the card to pass over one it hides', async () => {
      await workflowRun();
      const row = (seq: number, payload: Record<string, unknown>) =>
        dao.create({
          runId: 'run-a',
          seq,
          kind: 'tool_call',
          nodeId: 'qa',
          payload: JSON.stringify({ ...payload, callId: 'call-2' }),
        });
      await row(9, { id: 't1', name: 'Bash' });
      // Newer, and one of geniro's own: the folded card never draws it.
      await row(10, { id: 't2', name: 'mcp__geniro__show_chart' });

      const { anchors } = await readingService().read(
        'run-a',
        -1,
        { limit: 50 },
        { root: true },
      );

      expect(
        anchors
          .filter(
            (item) =>
              item.kind === 'tool_call' &&
              (item.payload as { callId?: string }).callId === 'call-2',
          )
          .map((item) => item.seq),
      ).toEqual([9, 10]);
    });

    /** One row of the run, written the way the tests above write theirs. */
    const row = (
      seq: number,
      kind: ItemKind,
      nodeId: string,
      payload: unknown,
    ): Promise<unknown> =>
      dao.create({
        runId: 'run-a',
        seq,
        kind,
        nodeId,
        payload: JSON.stringify(payload),
      });

    /** The seqs of `call`'s rows of `kinds` anchored to the run's newest root page. */
    async function anchoredOf(
      call: string,
      kinds: readonly ItemKind[],
    ): Promise<number[]> {
      const { anchors } = await readingService().read(
        'run-a',
        -1,
        { limit: 50 },
        { root: true },
      );
      return anchors
        .filter(
          (item) =>
            kinds.includes(item.kind) &&
            (item.payload as { callId?: string } | null)?.callId === call,
        )
        .map((item) => item.seq);
    }

    it("caps a call's card rows per kind, so a flood of one kind never crowds out another", async () => {
      await workflowRun();
      await row(90, 'turn_complete', 'qa', { callId: 'call-2' });
      for (let seq = 100; seq < 310; seq += 1) {
        await row(seq, 'status', 'qa', { callId: 'call-2', status: 'running' });
      }

      const statuses = await anchoredOf('call-2', ['status']);
      expect(statuses).toHaveLength(200);
      expect(statuses[0]).toBe(110);
      expect(await anchoredOf('call-2', ['turn_complete'])).toEqual([90]);
    });

    it('anchors a turn that ended in an error or was cancelled — without it the turn reads as still running', async () => {
      await workflowRun();
      await row(9, 'status', 'qa', { callId: 'call-2', status: 'running' });
      await row(10, 'error', 'qa', { callId: 'call-2', message: 'boom' });
      await row(11, 'status', 'qa', { callId: 'call-2', status: 'running' });
      await row(12, 'turn_cancelled', 'qa', { callId: 'call-2' });

      expect(await anchoredOf('call-2', ['error', 'turn_cancelled'])).toEqual([
        10, 12,
      ]);
    });

    it("anchors a call's task lists from the newest one stating the whole list", async () => {
      await workflowRun();
      await row(9, 'task_list', 'qa', { callId: 'call-2', mode: 'patch' });
      await row(10, 'task_list', 'qa', { callId: 'call-2', mode: 'snapshot' });
      await row(11, 'task_list', 'qa', { callId: 'call-2', mode: 'patch' });
      await row(12, 'task_list', 'qa', { callId: 'call-2', mode: 'patch' });

      expect(await anchoredOf('call-2', ['task_list'])).toEqual([10, 11, 12]);
    });

    it('anchors every task list of a call that never stated a whole one', async () => {
      await workflowRun();
      await row(9, 'task_list', 'qa', { callId: 'call-2', mode: 'patch' });
      await row(10, 'task_list', 'qa', { callId: 'call-2', mode: 'patch' });

      expect(await anchoredOf('call-2', ['task_list'])).toEqual([9, 10]);
    });

    it("anchors every tool call of a call's turn still running — and not a settled turn's", async () => {
      await workflowRun();
      // A settled turn's tools, naming nothing: no reading needs them.
      await row(9, 'status', 'qa', { callId: 'call-2', status: 'running' });
      await row(10, 'tool_call', 'qa', { id: 'old', callId: 'call-2' });
      await row(11, 'status', 'qa', { callId: 'call-2', status: 'completed' });
      // The turn in flight: more tools than the named reading keeps, unnamed.
      await row(12, 'status', 'qa', { callId: 'call-2', status: 'running' });
      for (let seq = 13; seq < 33; seq += 1) {
        await row(seq, 'tool_call', 'qa', { id: `t${seq}`, callId: 'call-2' });
      }

      const tools = await anchoredOf('call-2', ['tool_call']);
      expect(tools).toHaveLength(20);
      expect(tools).not.toContain(10);
    });

    it('anchors the calls that run across a page of the run’s own flow but began above it', async () => {
      await workflowRun();
      // call-2 settles before the page, call-4 below it; call-1 (continued by
      // call-3) never settles.
      await row(15, 'call_result', 'manager', { callId: 'call-2', ok: true });
      await row(16, 'call_started', 'manager', {
        callId: 'call-4',
        calleeNodeId: 'qa',
      });
      await row(17, 'message', 'qa', { text: 'on it', callId: 'call-4' });
      await row(19, 'message', 'manager', { text: 'waiting' });
      await row(20, 'call_result', 'manager', { callId: 'call-4', ok: true });
      const page = (await dao.getByRun('run-a', 18, orm.em.fork()))
        .filter((item) => item.seq === 19)
        .map(itemToWire);

      const { anchors } = await service(page).read(
        'run-a',
        -1,
        { limit: 50 },
        { root: true },
      );

      const starts = anchors
        .filter((item) => item.kind === 'call_started')
        .map((item) => (item.payload as { callId: string }).callId);
      expect(starts).toEqual(['call-1', 'call-3', 'call-4']);
      expect(anchors.map((item) => item.seq)).toEqual(
        expect.arrayContaining([3, 8, 17, 20]),
      );
    });

    it('anchors a call that began above the page and settled within it — its settle is filed under the call, never on the page', async () => {
      await workflowRun();
      await row(16, 'call_started', 'manager', {
        callId: 'call-4',
        calleeNodeId: 'qa',
      });
      await row(17, 'message', 'qa', { text: 'on it', callId: 'call-4' });
      await row(19, 'message', 'manager', { text: 'waiting' });
      await row(20, 'call_result', 'manager', { callId: 'call-4', ok: true });
      await row(21, 'message', 'manager', { text: 'qa answered' });
      const page = (await dao.getByRun('run-a', 18, orm.em.fork()))
        .filter((item) => item.seq === 19 || item.seq === 21)
        .map(itemToWire);

      const { anchors } = await service(page).read(
        'run-a',
        -1,
        { limit: 50 },
        { root: true },
      );

      expect(
        anchors
          .filter((item) => item.kind === 'call_started')
          .map((item) => (item.payload as { callId: string }).callId),
      ).toContain('call-4');
      expect(anchors.map((item) => item.seq)).toEqual(
        expect.arrayContaining([16, 17, 20]),
      );
    });

    it("anchors what closes a call's anchored rows — a tool call's reply, its shells and delegates opened and ended", async () => {
      await workflowRun();
      await row(9, 'tool_call', 'qa', {
        id: 't9',
        name: 'Bash',
        callId: 'call-2',
      });
      await row(10, 'tool_result', 'qa', { id: 't9', callId: 'call-2' });
      // A reply to a tool call no reading anchors.
      await row(11, 'tool_result', 'qa', { id: 't-old', callId: 'call-2' });
      await row(12, 'shell_open', 'qa', { id: 's1', callId: 'call-2' });
      await row(13, 'shell_info', 'qa', { id: 's1', callId: 'call-2' });
      await row(14, 'subagent_info', 'qa', { id: 'd1', callId: 'call-2' });
      await row(15, 'message', 'qa', { text: 'later', callId: 'call-2' });

      const anchored = await anchoredOf('call-2', [
        'tool_result',
        'shell_open',
        'shell_info',
        'subagent_info',
      ]);
      expect(anchored).toEqual([10, 12, 13, 14]);
    });

    it("anchors the callee's own newest words, never a delegate's", async () => {
      await workflowRun();
      await row(9, 'message', 'qa', { text: 'mine', callId: 'call-2' });
      await row(10, 'message', 'qa', {
        text: "the delegate's",
        callId: 'call-2',
        parentToolUseId: 'task-1',
      });
      await row(11, 'reasoning', 'qa', { text: 'next', callId: 'call-2' });

      expect(await anchoredOf('call-2', ['message'])).toEqual([9]);
    });

    it("anchors the row saying a callee's turn took its approval card down", async () => {
      await workflowRun();
      await row(29, 'unanswerable', 'eng', { id: 'req-0', callId: 'call-1' });
      await row(30, 'approval_request', 'eng', {
        id: 'req-9',
        callId: 'call-1',
      });
      await row(31, 'unanswerable', 'eng', { id: 'req-9', callId: 'call-1' });
      // The call's newest row, so neither is anchored as that.
      await row(32, 'reasoning', 'eng', { text: 'next', callId: 'call-1' });

      const { items, anchors } = await readingService().read(
        'run-a',
        -1,
        { limit: 50 },
        { root: true },
      );

      expect(items.map((item) => item.seq)).toContain(30);
      expect(
        anchors
          .filter((item) => item.kind === 'unanswerable')
          .map((item) => item.seq),
      ).toEqual([31]);
    });

    it("anchors none of a call's rows to a page of that call's own conversation", async () => {
      await workflowRun();

      const { anchors } = await readingService().read(
        'run-a',
        -1,
        { limit: 50 },
        { call: 'call-1' },
      );

      expect(anchors.map((item) => item.seq)).toEqual([2, 7]);
    });

    it("reads every row of a chat for its own flow — a chat's agent calls no one", async () => {
      await new RunDao(orm.em.fork()).create({ id: 'run-a' });
      await insert(1, 'message', { text: 'hi' });
      await insert(2, 'message', { text: 'there', callId: 'call-1' });

      const { items } = await readingService().read(
        'run-a',
        -1,
        { limit: 50 },
        { root: true },
      );

      expect(items.map((item) => item.seq)).toEqual([1, 2]);
      // Nothing was indexed to answer it.
      expect((await dao.getByRun('run-a')).map((row) => row.inCall)).toEqual([
        null,
        null,
      ]);
    });

    it('still reads the whole run when no conversation is named', async () => {
      await workflowRun();

      const { items } = await readingService().read('run-a', -1, {
        limit: 50,
      });

      expect(items.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });
  });

  async function pageOf(from: number, to: number): Promise<ItemWire[]> {
    return (await dao.getByRun('run-a'))
      .filter((item) => item.seq >= from && item.seq <= to)
      .map(itemToWire);
  }

  it('anchors a call the page streams into with its start and settle from outside it', async () => {
    await insert(1, 'call_started', { callId: 'call-3', calleeNodeId: 'qa' });
    await insert(2, 'call_result', { callId: 'call-3', status: 'ok' });
    await insert(3, 'call_started', { callId: 'call-4', calleeNodeId: 'qa' });
    await insert(10, 'status', { callId: 'call-3', status: 'running' });
    const page = await pageOf(10, 10);

    const anchors = await service().anchorsFor('run-a', page);

    // call-4 is not named by the page — the window draws only what it holds.
    expect(anchors.map((item) => item.seq)).toEqual([1, 2]);
  });

  it("anchors a call's pool HAND-OFF from above the page — and no other system row", async () => {
    await insert(1, 'call_started', { callId: 'call-1', member: 1 });
    await insert(2, 'system', {
      callId: 'call-1',
      severity: 'info',
      member: 2,
      message: 'handing the call to member 2',
    });
    // A system row on the call that names no member is not a hand-off.
    await insert(3, 'system', { callId: 'call-1', message: 'stalled' });
    // Another call's hand-off is not this page's.
    await insert(4, 'call_started', { callId: 'call-9', member: 1 });
    await insert(5, 'system', { callId: 'call-9', member: 3, message: 'x' });
    await insert(10, 'status', { callId: 'call-1', status: 'running' });
    const page = await pageOf(10, 10);

    const anchors = await service().anchorsFor('run-a', page);

    expect(anchors.map((item) => item.seq)).toEqual([1, 2]);
  });

  it("brings a call's whole conversation, the continuation BELOW the page included", async () => {
    await insert(1, 'call_started', { callId: 'call-1' });
    await insert(2, 'call_result', { callId: 'call-1', status: 'ok' });
    await insert(5, 'status', { callId: 'call-1', status: 'completed' });
    await insert(9, 'call_started', { callId: 'call-2', thread: 'call-1' });
    const page = await pageOf(5, 5);

    const anchors = await service().anchorsFor('run-a', page);

    expect(anchors.map((item) => item.seq)).toEqual([1, 2, 9]);
  });

  it("anchors a delegate's launch, its reply and every declaration from outside the page", async () => {
    await insert(1, 'tool_call', { id: 'task-1', name: 'Task' });
    await insert(2, 'subagent_info', { id: 'task-1', label: 'Reviewer' });
    await insert(3, 'tool_result', { id: 'task-1', result: 'done' });
    await insert(4, 'subagent_info', { id: 'task-1', label: null });
    await insert(10, 'message', { text: 'x', parentToolUseId: 'task-1' });
    const page = await pageOf(10, 10);

    const anchors = await service().anchorsFor('run-a', page);

    expect(anchors.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
  });

  it('anchors the reply to a call the page leaves unanswered — only from below it', async () => {
    await insert(1, 'tool_result', { id: 't-1', result: 'stale' });
    await insert(10, 'tool_call', { id: 't-1', name: 'Bash' });
    await insert(15, 'tool_result', { id: 't-1', result: 'ok' });
    const page = await pageOf(10, 10);

    const anchors = await service().anchorsFor('run-a', page);

    expect(anchors.map((item) => item.seq)).toEqual([15]);
  });

  it("anchors a delegate's reply on EITHER side — a backgrounded launch is answered at once", async () => {
    await insert(1, 'tool_call', { id: 'task-1', name: 'Task' });
    await insert(10, 'message', { text: 'x', parentToolUseId: 'task-1' });
    await insert(20, 'tool_result', { id: 'task-1', result: 'done' });
    const page = await pageOf(10, 10);

    const anchors = await service().anchorsFor('run-a', page);

    expect(anchors.map((item) => item.seq)).toEqual([1, 20]);
  });

  it('matches a tool id EXACTLY — `x-5` never reaches `x-50`', async () => {
    await insert(1, 'tool_call', { id: 'x-5', name: 'Bash' });
    await insert(2, 'tool_call', { id: 'x-50', name: 'Bash' });
    await insert(10, 'tool_result', { id: 'x-5', result: 'ok' });
    const page = await pageOf(10, 10);

    const anchors = await service().anchorsFor('run-a', page);

    expect(anchors.map((item) => item.seq)).toEqual([1]);
  });

  it("anchors a workflow's first announcement — the only one stating its name", async () => {
    await insert(1, 'tool_call', { id: 'wf-1', name: 'Workflow' });
    await insert(2, 'workflow_info', { id: 'wf-1', title: 'Audit' });
    await insert(3, 'workflow_info', { id: 'wf-1', agents: [] });
    await insert(10, 'workflow_info', { id: 'wf-1', agents: [{}] });
    const page = await pageOf(10, 10);

    const anchors = await service().anchorsFor('run-a', page);

    expect(anchors.map((item) => item.seq)).toEqual([1, 2]);
  });

  it("never anchors a row the page holds, nor another run's rows", async () => {
    await insert(1, 'call_started', { callId: 'call-1' });
    await insert(2, 'status', { callId: 'call-1', status: 'running' });
    await insert(0, 'call_result', { callId: 'call-1' }, 'run-b');
    const page = await pageOf(1, 2);

    expect(await service().anchorsFor('run-a', page)).toEqual([]);
  });

  it('answers the page and its anchors together', async () => {
    await insert(1, 'call_started', { callId: 'call-1' });
    await insert(10, 'status', { callId: 'call-1', status: 'running' });
    const page = await pageOf(10, 10);

    const history = await service(page).read('run-a', -1, { limit: 1 });

    expect(history.items.map((item) => item.seq)).toEqual([10]);
    expect(history.anchors.map((item) => item.seq)).toEqual([1]);
  });

  it('never anchors the PROBE row of a full page — the client drops it', async () => {
    await insert(1, 'call_started', { callId: 'call-1' });
    await insert(2, 'call_started', { callId: 'call-2' });
    await insert(10, 'status', { callId: 'call-1', status: 'running' });
    await insert(11, 'status', { callId: 'call-2', status: 'running' });
    const page = await pageOf(10, 11);

    const history = await service(page).read('run-a', 9, {
      limit: 2,
      take: 'oldest',
      probe: true,
    });

    expect(history.items.map((item) => item.seq)).toEqual([10, 11]);
    expect(history.anchors.map((item) => item.seq)).toEqual([1]);
  });

  it('anchors every row of a SHORT probe page — nothing past it was read', async () => {
    await insert(1, 'call_started', { callId: 'call-1' });
    await insert(2, 'call_started', { callId: 'call-2' });
    await insert(10, 'status', { callId: 'call-1', status: 'running' });
    await insert(11, 'status', { callId: 'call-2', status: 'running' });
    const page = await pageOf(10, 11);

    const history = await service(page).read('run-a', 9, {
      limit: 3,
      take: 'oldest',
      probe: true,
    });

    expect(history.anchors.map((item) => item.seq)).toEqual([1, 2]);
  });
});

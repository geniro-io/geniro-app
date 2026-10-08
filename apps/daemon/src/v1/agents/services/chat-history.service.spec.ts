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
import type { ItemWire } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { itemToWire } from '../utils/item-wire';
import type { ChatService } from './chat.service';
import { ChatHistoryService } from './chat-history.service';

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
    return new ChatHistoryService(orm.em, dao, chats);
  }

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

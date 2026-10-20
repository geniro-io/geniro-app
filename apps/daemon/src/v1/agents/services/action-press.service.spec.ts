import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { ConflictException } from '@packages/common';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { NO_CALL_INDEX } from '../__tests__/no-call-index';
import { NO_STOPS } from '../__tests__/no-stops';
import { type ActionPressResult, SINGLE_AGENT_NODE } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { parseJsonColumn } from '../utils/json-util';
import { ActionPressService } from './action-press.service';
import {
  type ActionPublishContext,
  ActionPublishService,
} from './action-publish.service';
import type { ActionStopService } from './action-stop.service';
import { AgentEventBus } from './agent-events.bus';
import type { ChatService } from './chat.service';
import { ChatActionsService } from './chat-actions.service';
import { ItemSeqAllocator } from './item-seq.allocator';

/** Real SQLite, so the outcome a press writes is read back through the same fold run state serves. */
describe('ActionPressService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let items: ItemDao;
  let runs: RunDao;
  let actions: ChatActionsService;
  let publisher: ActionPublishService;
  let sendMessage: ReturnType<typeof vi.fn>;
  let presses: ActionPressService;

  const ctx: ActionPublishContext = {
    runId: 'run-a',
    rowNodeId: null,
    publisher: { nodeId: SINGLE_AGENT_NODE, conversationId: '' },
  };

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
    items = new ItemDao(orm.em.fork());
    runs = new RunDao(orm.em.fork());
    actions = new ChatActionsService(
      orm.em,
      items,
      new AgentEventBus(),
      NO_CALL_INDEX,
      new ItemSeqAllocator(orm.em, items),
    );
    publisher = new ActionPublishService(actions, NO_STOPS);
    sendMessage = vi.fn(() => Promise.resolve({ seq: 99 }));
    presses = new ActionPressService(
      orm.em,
      runs,
      actions,
      { sendMessage } as unknown as ChatService,
      NO_STOPS,
    );
    await runs.create({ id: 'run-a', status: 'completed', workflowId: null });
  });

  async function publishedSeq(actionId: string): Promise<number> {
    const live = await actions.live('run-a');
    return live.find((action) => action.actionId === actionId)!.seq;
  }

  it('message press sends with clientMessageId, writes succeeded, one-shot leaves the live set', async () => {
    await publisher.publish(ctx, { label: 'PR merged', message: 'continue' });
    const seq = await publishedSeq('pr-merged');

    const result = await presses.pressChat('run-a', seq, 'client-1', 'remote');

    expect(sendMessage).toHaveBeenCalledWith('run-a', 'continue', [], {
      clientMessageId: 'client-1',
    });
    expect(result.outcome).toEqual({
      actionSeq: seq,
      actionId: 'pr-merged',
      nodeId: SINGLE_AGENT_NODE,
      conversationId: '',
      state: 'succeeded',
      via: 'remote',
    });
    expect(await actions.live('run-a')).toEqual([]);
    await expect(
      presses.pressChat('run-a', seq, 'client-2', 'desktop'),
    ).rejects.toMatchObject({ errorCode: 'ACTION_GONE' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps a reusable action live after a press', async () => {
    await publisher.publish(ctx, {
      label: 'Ping',
      message: 'ping',
      once: false,
    });
    const seq = await publishedSeq('ping');

    await presses.pressChat('run-a', seq, 'c1', 'desktop');

    expect(await actions.live('run-a')).toMatchObject([
      { seq, lastOutcome: { state: 'succeeded' } },
    ]);
  });

  it('refuses a press of a publish the agent has since replaced', async () => {
    await publisher.publish(ctx, { label: 'Ship', message: 'v1' });
    const old = await publishedSeq('ship');
    await publisher.publish(ctx, { label: 'Ship', message: 'v2' });

    await expect(
      presses.pressChat('run-a', old, 'c1', 'desktop'),
    ).rejects.toMatchObject({ errorCode: 'ACTION_CHANGED' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('writes nothing when the chat answers RUN_BUSY, so the same seq can be pressed again', async () => {
    await publisher.publish(ctx, { label: 'Go', message: 'go' });
    const seq = await publishedSeq('go');
    sendMessage.mockRejectedValueOnce(
      new ConflictException('RUN_BUSY', 'a turn is running'),
    );

    await expect(
      presses.pressChat('run-a', seq, 'c1', 'desktop'),
    ).rejects.toMatchObject({ errorCode: 'RUN_BUSY' });
    expect(await items.rowsOfKinds('run-a', ['action_outcome'])).toEqual([]);

    await presses.pressChat('run-a', seq, 'c1', 'desktop');
    expect(sendMessage).toHaveBeenLastCalledWith('run-a', 'go', [], {
      clientMessageId: 'c1',
    });
    expect(await actions.live('run-a')).toEqual([]);
  });

  it('refuses a press while one is under way', async () => {
    await publisher.publish(ctx, { label: 'Go', message: 'go' });
    const seq = await publishedSeq('go');
    await actions.appendOutcome('run-a', null, {
      actionSeq: seq,
      actionId: 'go',
      nodeId: SINGLE_AGENT_NODE,
      conversationId: '',
      state: 'pressed',
    });

    await expect(
      presses.pressChat('run-a', seq, 'c1', 'desktop'),
    ).rejects.toMatchObject({ errorCode: 'ACTION_BUSY' });
  });

  it('dismiss writes dismissed and the agent is not messaged', async () => {
    await publisher.publish(ctx, { label: 'Go', message: 'go', once: false });
    const seq = await publishedSeq('go');

    const result = await presses.dismissChat('run-a', seq, 'desktop');

    expect(result.outcome).toMatchObject({
      state: 'dismissed',
      via: 'desktop',
    });
    expect(await actions.live('run-a')).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('archived run refuses press', async () => {
    await publisher.publish(ctx, { label: 'Go', message: 'go' });
    const seq = await publishedSeq('go');
    await runs.create({
      id: 'run-b',
      status: 'completed',
      workflowId: null,
      archivedAt: new Date(),
    });
    await publisher.publish(
      { ...ctx, runId: 'run-b' },
      {
        label: 'Go',
        message: 'go',
      },
    );
    const archivedSeq = (await actions.live('run-b'))[0]!.seq;

    await expect(
      presses.pressChat('run-b', archivedSeq, 'c1', 'desktop'),
    ).rejects.toMatchObject({ errorCode: 'RUN_ARCHIVED' });
    expect(sendMessage).not.toHaveBeenCalled();
    await presses.pressChat('run-a', seq, 'c1', 'desktop');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('two presses at once send the message once: the second finds the button gone', async () => {
    await publisher.publish(ctx, { label: 'Go', message: 'go' });
    const seq = await publishedSeq('go');
    // A send that takes a while, so the second press arrives while it is out.
    let release: () => void = () => undefined;
    sendMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ seq: 99 });
        }),
    );

    const first = presses.pressChat('run-a', seq, 'desk', 'desktop');
    const second = presses.pressChat('run-a', seq, 'phone', 'remote');
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    release();

    const results = await Promise.allSettled([first, second]);
    expect(results[0]).toMatchObject({ status: 'fulfilled' });
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { errorCode: 'ACTION_GONE' },
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('a press that failed does not hold up the next one', async () => {
    await publisher.publish(ctx, { label: 'Go', message: 'go' });
    const seq = await publishedSeq('go');
    sendMessage.mockRejectedValueOnce(new Error('spawn failed'));

    await expect(
      presses.pressChat('run-a', seq, 'c1', 'desktop'),
    ).rejects.toThrow('spawn failed');
    await presses.pressChat('run-a', seq, 'c1', 'desktop');

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(await actions.live('run-a')).toEqual([]);
  });

  it('archived run refuses a dismissal too', async () => {
    await runs.create({
      id: 'run-b',
      status: 'completed',
      workflowId: null,
      archivedAt: new Date(),
    });
    await publisher.publish(
      { ...ctx, runId: 'run-b' },
      {
        label: 'Go',
        message: 'go',
      },
    );
    const seq = (await actions.live('run-b'))[0]!.seq;

    await expect(
      presses.dismissChat('run-b', seq, 'desktop'),
    ).rejects.toMatchObject({ errorCode: 'RUN_ARCHIVED' });
    expect(await actions.live('run-b')).toHaveLength(1);
  });

  it('refuses a workflow run on the chat routes, which has routes of its own', async () => {
    await runs.create({ id: 'run-w', status: 'running', workflowId: 'team' });
    await publisher.publish(
      { ...ctx, runId: 'run-w' },
      { label: 'Go', message: 'go' },
    );
    const seq = (await actions.live('run-w'))[0]!.seq;

    await expect(
      presses.pressChat('run-w', seq, 'c1', 'desktop'),
    ).rejects.toMatchObject({ errorCode: 'NOT_A_CHAT_RUN' });
    await expect(
      presses.dismissChat('run-w', seq, 'desktop'),
    ).rejects.toMatchObject({ errorCode: 'NOT_A_CHAT_RUN' });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await actions.live('run-w')).toHaveLength(1);
  });

  it('refuses an unknown run', async () => {
    await expect(
      presses.pressChat('nope', 1, 'c1', 'desktop'),
    ).rejects.toMatchObject({ errorCode: 'RUN_NOT_FOUND' });
  });

  describe('stop presses', () => {
    const TARGETS = [
      {
        pid: 48211,
        startedAt: '2026-10-20T10:00:00.000Z',
        command: 'python3 -m http.server 8765',
      },
    ];
    let stopCalls: unknown[][];
    let stopResult: () => Promise<ActionPressResult>;
    let stopper: ActionPressService;

    beforeEach(async () => {
      stopCalls = [];
      stopResult = () => Promise.resolve({ state: 'stopped' });
      const stops = {
        resolve: () => Promise.resolve({ targets: TARGETS }),
        stop: (...args: unknown[]) => {
          stopCalls.push(args);
          return stopResult();
        },
      } as unknown as ActionStopService;
      publisher = new ActionPublishService(actions, stops);
      stopper = new ActionPressService(
        orm.em,
        runs,
        actions,
        { sendMessage } as unknown as ChatService,
        stops,
      );
      await publisher.publish(ctx, {
        label: 'Stop preview',
        stop: { pid: 48211 },
      });
    });

    it('stops what the action recorded and retires it', async () => {
      const seq = await publishedSeq('stop-preview');

      const result = await stopper.pressChat('run-a', seq, 'c1', 'desktop');

      expect(stopCalls).toEqual([
        ['run-a', { kind: 'stop', targets: TARGETS }],
      ]);
      expect(result.outcome).toMatchObject({
        state: 'stopped',
        via: 'desktop',
      });
      expect(result.outcome.alreadyStopped).toBeUndefined();
      expect(await actions.live('run-a')).toEqual([]);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('records already stopped, and retires the button', async () => {
      stopResult = () =>
        Promise.resolve({ state: 'stopped', alreadyStopped: true });
      const seq = await publishedSeq('stop-preview');

      const result = await stopper.pressChat('run-a', seq, 'c1', 'desktop');

      expect(result.outcome).toMatchObject({
        state: 'stopped',
        alreadyStopped: true,
      });
      expect(await actions.live('run-a')).toEqual([]);
    });

    it('records a refused stop as failed and keeps the button live', async () => {
      stopResult = () =>
        Promise.resolve({
          state: 'failed',
          error:
            'pid 48211 is no longer a process this thread may stop; stopped none',
        });
      const seq = await publishedSeq('stop-preview');

      const result = await stopper.pressChat('run-a', seq, 'c1', 'desktop');

      expect(result.outcome).toMatchObject({
        state: 'failed',
        error:
          'pid 48211 is no longer a process this thread may stop; stopped none',
      });
      expect(await actions.live('run-a')).toMatchObject([
        { seq, lastOutcome: { state: 'failed' } },
      ]);
    });

    it('answers ACTION_BUSY to a second press or a dismissal while it stops, without holding the run', async () => {
      let finish: (outcome: ActionPressResult) => void = () => undefined;
      stopResult = () =>
        new Promise<ActionPressResult>((resolve) => {
          finish = resolve;
        });
      const seq = await publishedSeq('stop-preview');

      const first = stopper.pressChat('run-a', seq, 'c1', 'desktop');
      await vi.waitFor(() => expect(stopCalls).toHaveLength(1));

      await expect(
        stopper.pressChat('run-a', seq, 'c2', 'remote'),
      ).rejects.toMatchObject({ errorCode: 'ACTION_BUSY' });
      await expect(
        stopper.dismissChat('run-a', seq, 'desktop'),
      ).rejects.toMatchObject({ errorCode: 'ACTION_BUSY' });
      // The run's lock is free meanwhile: another button publishes.
      expect(
        await publisher.publish(ctx, { label: 'Ping', message: 'ping' }),
      ).toMatchObject({ status: 'published' });

      finish({ state: 'stopped' });
      expect((await first).outcome.state).toBe('stopped');
      expect(stopCalls).toHaveLength(1);
    });

    it('keeps a button the agent removed while it stopped removed when the stop fails', async () => {
      let finish: (outcome: ActionPressResult) => void = () => undefined;
      stopResult = () =>
        new Promise<ActionPressResult>((resolve) => {
          finish = resolve;
        });
      const seq = await publishedSeq('stop-preview');

      const pressed = stopper.pressChat('run-a', seq, 'c1', 'desktop');
      await vi.waitFor(() => expect(stopCalls).toHaveLength(1));
      expect(await publisher.remove(ctx, 'stop-preview')).toMatchObject({
        status: 'removed',
      });
      finish({
        state: 'failed',
        error:
          'pid 48211 is no longer a process this thread may stop; stopped none',
      });

      await expect(pressed).rejects.toMatchObject({
        errorCode: 'ACTION_GONE',
      });
      expect(await actions.live('run-a')).toEqual([]);
      expect(
        (await items.rowsOfKinds('run-a', ['action_outcome'])).map(
          (row) =>
            (parseJsonColumn(row.payload) as { state: string } | null)?.state,
        ),
      ).toEqual(['removed']);
    });

    it('answers ACTION_CHANGED when the agent republished the button while it stopped', async () => {
      let finish: (outcome: ActionPressResult) => void = () => undefined;
      stopResult = () =>
        new Promise<ActionPressResult>((resolve) => {
          finish = resolve;
        });
      const seq = await publishedSeq('stop-preview');

      const pressed = stopper.pressChat('run-a', seq, 'c1', 'desktop');
      await vi.waitFor(() => expect(stopCalls).toHaveLength(1));
      await publisher.publish(ctx, {
        label: 'Stop preview',
        stop: { pid: 48211 },
      });
      finish({ state: 'failed', error: 'stopped none' });

      await expect(pressed).rejects.toMatchObject({
        errorCode: 'ACTION_CHANGED',
      });
      expect(await items.rowsOfKinds('run-a', ['action_outcome'])).toEqual([]);
    });

    it('frees the button for another press when the stop throws', async () => {
      stopResult = () => Promise.reject(new Error('boom'));
      const seq = await publishedSeq('stop-preview');

      await expect(
        stopper.pressChat('run-a', seq, 'c1', 'desktop'),
      ).rejects.toThrow('boom');
      stopResult = () => Promise.resolve({ state: 'stopped' });
      expect(
        (await stopper.pressChat('run-a', seq, 'c2', 'desktop')).outcome.state,
      ).toBe('stopped');
    });
  });
});

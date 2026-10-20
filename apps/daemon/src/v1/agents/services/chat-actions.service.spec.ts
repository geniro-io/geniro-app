import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { NO_CALL_INDEX } from '../__tests__/no-call-index';
import { ACTION_LIVE_MAX, SINGLE_AGENT_NODE } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import {
  type ActionPublishContext,
  ActionPublishService,
} from './action-publish.service';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentEventBus } from './agent-events.bus';
import { ApprovalRegistry } from './approval-registry';
import { ChatActionsService } from './chat-actions.service';
import type { ChatShellsService } from './chat-shells.service';
import { ItemSeqAllocator } from './item-seq.allocator';
import { RunStateService } from './run-state.service';

/**
 * Real SQLite end to end: a publish is written through `persistItemAndEmit`
 * and read back through the run-state route's service, so what is pinned is
 * what a client actually receives.
 */
describe('ChatActionsService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let items: ItemDao;
  let runs: RunDao;
  let actions: ChatActionsService;
  let publisher: ActionPublishService;
  let state: RunStateService;

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
    const seqs = new ItemSeqAllocator(orm.em, items);
    actions = new ChatActionsService(
      orm.em,
      items,
      new AgentEventBus(),
      NO_CALL_INDEX,
      seqs,
    );
    publisher = new ActionPublishService(actions);
    state = new RunStateService(
      orm.em,
      runs,
      items,
      new ApprovalRegistry(),
      {
        read: () => Promise.resolve({ shells: [] }),
      } as unknown as ChatShellsService,
      { all: () => new Map() } as unknown as AgentAdapterRegistry,
      seqs,
      actions,
    );
    await runs.create({ id: 'run-a', status: 'running', workflowId: null });
  });

  it('publishes a message action and serves it in run state', async () => {
    const outcome = await publisher.publish(ctx, {
      label: 'PR merged',
      description: 'Tell the agent the PR landed',
      message: 'PR merged — continue',
    });

    expect(outcome).toEqual({
      status: 'published',
      text: `Published action "pr-merged" (message). Re-publish the same action_id to change it; remove_action "pr-merged" retires it. 1/${ACTION_LIVE_MAX} live.`,
    });
    const { actions: live } = await state.read('run-a');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      actionId: 'pr-merged',
      label: 'PR merged',
      description: 'Tell the agent the PR landed',
      once: true,
      pending: false,
      spec: { kind: 'message', text: 'PR merged — continue' },
      publisher: { nodeId: SINGLE_AGENT_NODE, conversationId: '' },
    });
  });

  it('replaces an action re-published with the same id', async () => {
    await publisher.publish(ctx, { label: 'Ship', message: 'ship v1' });
    await publisher.publish(ctx, {
      label: 'Ship it',
      actionId: 'ship',
      message: 'ship v2',
    });

    const live = await actions.live('run-a');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      label: 'Ship it',
      spec: { text: 'ship v2' },
    });
    const rows = await items.rowsOfKinds('run-a', ['action']);
    expect(live[0]!.seq).toBe(rows[1]!.seq);
  });

  it('refuses the 21st live action and lists the live ids', async () => {
    for (let i = 0; i < ACTION_LIVE_MAX; i += 1) {
      await publisher.publish(ctx, { label: `a${i}`, message: 'go' });
    }

    const refused = await publisher.publish(ctx, {
      label: 'one more',
      message: 'go',
    });

    expect(refused.status).toBe('refused');
    expect(refused).toMatchObject({
      reason: expect.stringContaining('(a19, a18, ') as string,
    });
    expect(await actions.live('run-a')).toHaveLength(ACTION_LIVE_MAX);
    // A republish of a live id is not a 21st action.
    expect(
      (await publisher.publish(ctx, { label: 'a3', message: 'again' })).status,
    ).toBe('published');
  });

  it.each([
    ['a bidi override', 'Merge\u202Eevil'],
    ['an isolate', 'Merge\u2066x'],
    ['a bidi mark', 'Merge\u200F'],
    ['a zero-width space', 'Mer\u200Bge'],
    ['a line separator', 'Merge\u2028now'],
    ['a Hangul filler', 'Merge\u3164'],
    ['a joiner outside an emoji', 'Mer\u200Dge'],
    ['a stray variation selector', 'Merge\uFE00'],
    ['a supplementary variation selector', 'ok\u{E0100}\u{E0101}'],
    ['a second presentation selector', 'Warn \u26A0\uFE0F\uFE0F'],
    ['a C1 control', 'Merge\u0085'],
    ['a newline', 'Merge\nnow'],
  ])('refuses %s in label', async (_name, label) => {
    const outcome = await publisher.publish(ctx, { label, message: 'go' });

    expect(outcome).toEqual({
      status: 'refused',
      reason:
        'label must not contain control, invisible or bidirectional characters',
    });
    expect(await actions.live('run-a')).toEqual([]);
  });

  it.each([
    [
      'a description over the cap',
      { label: 'x', description: 'd'.repeat(201), message: 'go' },
      'description must be at most 200 characters',
    ],
    [
      'a bidi override in the description',
      { label: 'x', description: 'safe\u202Eevil', message: 'go' },
      'description must not contain control, invisible or bidirectional characters',
    ],
    [
      'an empty message',
      { label: 'x', message: '   ' },
      'message must be 1–4000 characters',
    ],
    [
      'a message over the cap',
      { label: 'x', message: 'm'.repeat(4001) },
      'message must be 1–4000 characters',
    ],
    [
      'a control character in the message',
      { label: 'x', message: 'go\u0007' },
      'message must not contain control, invisible or bidirectional characters',
    ],
    [
      'an invisible tag in the message',
      { label: 'x', message: 'merged\u{E0041}\u{E0042}' },
      'message must not contain control, invisible or bidirectional characters',
    ],
    [
      'a C1 control in the message',
      { label: 'x', message: 'merged\u0085' },
      'message must not contain control, invisible or bidirectional characters',
    ],
    [
      'a bidi control in the message',
      { label: 'x', message: 'merge\u2067 main' },
      'message must not contain control, invisible or bidirectional characters',
    ],
    [
      'a label over the cap',
      { label: 'x'.repeat(41), message: 'go' },
      'label must be 1–40 characters',
    ],
    [
      'a malformed action_id',
      { label: 'x', actionId: '-bad', message: 'go' },
      'action_id must be 1–40 letters, digits, "-" or "_", starting with a letter or digit',
    ],
    [
      'a label with nothing to derive an id from',
      { label: '✅ !!', message: 'go' },
      'give an action_id: the label has no letters or digits to derive one from',
    ],
    [
      'a call naming no kind',
      { label: 'x' },
      'give exactly one of message, stop or command',
    ],
    [
      'a call naming two kinds',
      { label: 'x', message: 'go', command: { argv: ['ls'] } },
      'give exactly one of message, stop or command',
    ],
  ])('refuses %s', async (_name, input, reason) => {
    expect(await publisher.publish(ctx, input)).toEqual({
      status: 'refused',
      reason,
    });
    expect(await actions.live('run-a')).toEqual([]);
  });

  it('caps a derived id that lowercasing lengthened past the label', async () => {
    // 'İ' lowercases to two code units, so a 40-character label derives more.
    const outcome = await publisher.publish(ctx, {
      label: 'İ'.repeat(40),
      message: 'x',
    });

    expect(outcome.status).toBe('published');
    const [action] = await actions.live('run-a');
    expect(action!.actionId).toBe(`${'i-'.repeat(19)}i`);
  });

  it.each([
    ['a joined emoji', '\u{1F469}\u200D\u{1F4BB} Review'],
    ['a skin-toned joined emoji', '\u{1F469}\u{1F3FD}\u200D\u{1F4BB} Review'],
    ['a gendered emoji', 'Run \u{1F3C3}\u{1F3FD}\u200D\u2640\uFE0F'],
    ['a flag sequence', 'Ship \u{1F3F3}\uFE0F\u200D\u{1F308}'],
    ['a keycap', 'Step 1\uFE0F\u20E3'],
    ['an emoji presentation', 'Warn \u26A0\uFE0F'],
  ])('keeps %s usable in a label and a message', async (_name, label) => {
    const outcome = await publisher.publish(ctx, {
      label,
      message: `${label}\nship it`,
    });

    expect(outcome.status).toBe('published');
  });

  it('refuses a joiner or a variation selector hidden in a message', async () => {
    for (const message of ['go\u200Don', 'go\u{E0100}']) {
      expect(await publisher.publish(ctx, { label: 'x', message })).toEqual({
        status: 'refused',
        reason:
          'message must not contain control, invisible or bidirectional characters',
      });
    }
  });

  it('cuts a derived id by code point, never inside a surrogate pair', async () => {
    const outcome = await publisher.publish(ctx, {
      label: 'İ'.repeat(19) + 'a\u{10400}',
      message: 'x',
    });

    expect(outcome.status).toBe('published');
    const [action] = await actions.live('run-a');
    expect(action!.actionId).toBe(`${'i-'.repeat(19)}a\u{10428}`);
  });

  it('answers a failed write without the error, and publishes nothing', async () => {
    const failing = new ActionPublishService({
      serialize: actions.serialize.bind(actions),
      fold: actions.fold.bind(actions),
      appendAction: () =>
        Promise.reject(new Error('SQLITE_IOERR: /Users/x/geniro.db')),
      appendOutcome: () =>
        Promise.reject(new Error('SQLITE_IOERR: /Users/x/geniro.db')),
    } as unknown as ChatActionsService);

    expect(await failing.publish(ctx, { label: 'x', message: 'go' })).toEqual({
      status: 'refused',
      reason: 'the transcript row could not be written',
    });
    await publisher.publish(ctx, { label: 'Keep', message: 'k' });
    expect(await failing.remove(ctx, 'keep')).toEqual({
      status: 'refused',
      reason: 'the transcript row could not be written',
    });
    expect((await actions.live('run-a')).map((a) => a.actionId)).toEqual([
      'keep',
    ]);
  });

  it('answers stop and command as not available yet', async () => {
    expect(
      await publisher.publish(ctx, { label: 'Stop', stop: { pid: 1 } }),
    ).toMatchObject({
      reason:
        'stop actions are not available yet; publish a message action instead',
    });
    expect(
      await publisher.publish(ctx, { label: 'Run', command: { argv: ['ls'] } }),
    ).toMatchObject({
      reason:
        'command actions are not available yet; publish a message action instead',
    });
  });

  it('slugs a label in any script into a default id', async () => {
    await publisher.publish(ctx, { label: 'Остановить превью', message: 'x' });

    expect((await actions.live('run-a'))[0]!.actionId).toBe(
      'остановить-превью',
    );
  });

  it('remove_action retires the action and names the caller’s live ids otherwise', async () => {
    await publisher.publish(ctx, { label: 'Keep', message: 'k' });
    await publisher.publish(ctx, { label: 'Drop', message: 'd' });

    expect(await publisher.remove(ctx, 'drop')).toEqual({
      status: 'removed',
      text: 'Removed action "drop".',
    });
    expect((await actions.live('run-a')).map((a) => a.actionId)).toEqual([
      'keep',
    ]);
    expect(await publisher.remove(ctx, 'drop')).toEqual({
      status: 'refused',
      reason: 'No live action "drop". Yours: keep.',
    });
  });
});

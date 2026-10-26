import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import type { ItemKind } from '../../runs/runs.types';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import { ChatWaterfallService } from './chat-waterfall.service';
import type { ItemCallIndexService } from './item-call-index.service';
import type { PolledSpendService } from './polled-spend.service';
import {
  ITEM_TEXT_CHARS,
  OVERVIEW_BYTES,
  PAGE_BYTES,
  ThreadReaderService,
} from './thread-reader.service';
import { ThreadTimelineService } from './thread-timeline.service';

const T0 = Date.parse('2026-10-14T09:00:00.000Z');

describe('ThreadReaderService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let reader: ThreadReaderService;
  let itemDao: ItemDao;

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
    const em = orm.em.fork();
    itemDao = new ItemDao(em);
    const runDao = new RunDao(em);
    const waterfall = new ChatWaterfallService(
      em,
      itemDao,
      new NodeStateDao(em),
      runDao,
      { pollsSpend: () => false } as unknown as PolledSpendService,
    );
    reader = new ThreadReaderService(
      em,
      runDao,
      itemDao,
      new ThreadTimelineService(em, waterfall, itemDao, {
        ensureIndexed: () => Promise.resolve(),
      } as unknown as ItemCallIndexService),
      {
        for: (agent: string) => ({
          userInstructionsFile: (configDir: string | null) => ({
            path: `${configDir ?? `home-of-${agent}`}/RULES.md`,
          }),
        }),
      } as unknown as AgentAdapterRegistry,
    );
    const run = new Run();
    run.id = 'source';
    run.title = 'Slow thread';
    run.status = 'completed';
    run.agentKind = 'claude';
    run.cwd = '/tmp/project';
    const fork = orm.em.fork();
    fork.persist(run);
    await fork.flush();
  });

  afterEach(() => {
    clearSecrets();
  });

  async function insert(
    seq: number,
    kind: ItemKind,
    payload: unknown,
    seconds: number,
  ): Promise<void> {
    const fork = orm.em.fork();
    const at = new Date(T0 + seconds * 1000);
    fork.create(Item, {
      runId: 'source',
      seq,
      kind,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      ...(kind === 'message' ? { role: 'user' } : {}),
      createdAt: at,
      updatedAt: at,
    });
    await fork.flush();
  }

  it('times tool calls in the overview and keeps it inside its budget', async () => {
    await insert(0, 'message', { text: 'go' }, 0);
    await insert(1, 'tool_call', { id: 't1', name: 'Bash' }, 1);
    await insert(2, 'tool_result', { id: 't1', output: 'done' }, 91);
    await insert(3, 'turn_complete', { usage: { durationMs: 95_000 } }, 96);

    const answer = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 3, sourceWorking: false },
      { view: 'overview' },
    );

    expect(answer.source).toMatchObject({ kind: 'chat', title: 'Slow thread' });
    expect(answer.slowestTools).toEqual([
      expect.objectContaining({ seq: 1, name: 'Bash', ms: 90_000 }),
    ]);
    expect(answer.timing).toMatchObject({ wallMs: 96_000, toolCalls: 1 });
    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(
      OVERVIEW_BYTES,
    );
  });

  it('counts the team notes up to the snapshot and points at them only when there are some', async () => {
    const note = {
      kind: 'fact',
      text: 'CI is ubuntu',
      nodeId: 'a',
      conversationId: null,
    };
    await insert(0, 'message', { text: 'go' }, 0);
    await insert(1, 'team_note', note, 1);
    await insert(2, 'team_note', { ...note, kind: 'pitfall' }, 2);
    await insert(3, 'turn_complete', { usage: { durationMs: 3_000 } }, 3);
    // Written after the analysis began: outside its snapshot.
    await insert(4, 'team_note', note, 4);

    const answer = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 3, sourceWorking: false },
      { view: 'overview' },
    );
    expect(answer.teamNotes).toBe(2);
    expect(answer.next).toContain('kinds=["team_note"]');

    const before = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 0, sourceWorking: false },
      { view: 'overview' },
    );
    expect(before.teamNotes).toBe(0);
    expect(before.next).not.toContain('team_note');
  });

  it("names the chat agent's own instructions file, failed tool calls and the tokens it spent", async () => {
    await insert(0, 'message', { text: 'go' }, 0);
    await insert(1, 'tool_call', { id: 't1', name: 'Bash' }, 1);
    await insert(2, 'tool_result', { id: 't1', isError: true }, 2);
    await insert(3, 'tool_call', { id: 't2', name: 'Read' }, 3);
    await insert(4, 'tool_result', { id: 't2' }, 4);
    await insert(
      5,
      'turn_complete',
      {
        usage: {
          durationMs: 5_000,
          inputTokens: 1_200,
          outputTokens: 300,
          cacheReadTokens: 9_000,
          costUsd: 0.25,
        },
      },
      5,
    );

    const answer = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 5, sourceWorking: false },
      { view: 'overview' },
    );

    expect(answer.source).toMatchObject({
      userInstructions: [
        { agent: 'claude', configDir: null, path: 'home-of-claude/RULES.md' },
      ],
    });
    expect(answer.timing).toMatchObject({
      failedToolCalls: 1,
      inputTokens: 1_200,
      outputTokens: 300,
      cacheReadTokens: 9_000,
      costUsd: 0.25,
    });
    expect(answer.slowestTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ seq: 1, failed: true }),
        expect.not.objectContaining({ failed: true }),
      ]),
    );
    expect(answer.toolTotals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Bash', failed: 1 }),
        expect.objectContaining({ name: 'Read', failed: 0 }),
      ]),
    );
  });

  it('tells the analysis which part of the cost geniro priced itself', async () => {
    await insert(0, 'message', { text: 'go' }, 0);
    await insert(
      1,
      'turn_complete',
      { usage: { durationMs: 1_000, costUsd: 0.5, estimatedCostUsd: 0.5 } },
      1,
    );

    const answer = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 1, sourceWorking: false },
      { view: 'overview' },
    );

    expect(answer.timing).toMatchObject({
      costUsd: 0.5,
      estimatedCostUsd: 0.5,
    });
  });

  it('leaves usage it never measured null, not zero', async () => {
    await insert(0, 'message', { text: 'go' }, 0);
    await insert(1, 'turn_complete', { usage: { durationMs: 1_000 } }, 1);

    const answer = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 1, sourceWorking: false },
      { view: 'overview' },
    );

    expect(answer.timing).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
  });

  it('counts sub-agent tool calls apart and carries a turn’s cost split', async () => {
    await insert(0, 'message', { text: 'go' }, 0);
    await insert(1, 'tool_call', { id: 't1', name: 'Bash' }, 1);
    await insert(2, 'tool_result', { id: 't1', output: 'done' }, 2);
    await insert(
      3,
      'tool_call',
      { id: 't2', name: 'Read', parentToolUseId: 'toolu_agent' },
      3,
    );
    await insert(4, 'tool_result', { id: 't2', output: 'read' }, 4);
    await insert(
      5,
      'turn_complete',
      {
        usage: {
          durationMs: 6_000,
          costUsd: 3,
          modelCosts: [
            { model: 'haiku', costUsd: 2 },
            { model: 'opus', costUsd: 1 },
          ],
        },
      },
      6,
    );
    const source = {
      sourceRunId: 'source',
      snapshotSeq: 5,
      sourceWorking: false,
    };

    const overview = await reader.read(source, { view: 'overview' });
    expect(overview.timing).toMatchObject({
      toolCalls: 1,
      delegateToolCalls: 1,
    });
    expect(overview.nodes).toEqual([
      expect.objectContaining({ toolCalls: 1, delegateToolCalls: 1 }),
    ]);
    expect(overview.toolTotals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Bash', delegate: false, calls: 1 }),
        expect.objectContaining({ name: 'Read', delegate: true, calls: 1 }),
      ]),
    );
    expect(overview.slowestTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ seq: 3, delegate: true }),
        expect.objectContaining({ seq: 1, delegate: false }),
      ]),
    );
    const tools = (
      await reader.read(source, { view: 'spans', kinds: ['tool'] })
    ).spans as Record<string, unknown>[];
    expect(tools.map((span) => [span.seq, span.delegate])).toEqual(
      expect.arrayContaining([
        [1, false],
        [3, true],
      ]),
    );

    expect(overview.nodes).toEqual([
      expect.objectContaining({ toolMs: 1_000, delegateToolMs: 1_000 }),
    ]);
    const spans = (
      await reader.read(source, { view: 'spans', kinds: ['turn'] })
    ).spans as Record<string, unknown>[];
    expect(spans).toEqual([
      expect.objectContaining({
        toolCalls: 1,
        delegateToolCalls: 1,
        modelCosts: [
          { model: 'haiku', costUsd: 2 },
          { model: 'opus', costUsd: 1 },
        ],
      }),
    ]);
  });

  it('leaves the cost split out of a turn span that has none', async () => {
    await insert(0, 'message', { text: 'go' }, 0);
    await insert(
      1,
      'turn_complete',
      { usage: { durationMs: 1_000, costUsd: 1 } },
      1,
    );

    const spans = (
      await reader.read(
        { sourceRunId: 'source', snapshotSeq: 1, sourceWorking: false },
        { view: 'spans', kinds: ['turn'] },
      )
    ).spans as Record<string, unknown>[];
    expect(spans).toHaveLength(1);
    expect(spans[0]).not.toHaveProperty('modelCosts');
  });

  it('never returns a row past the snapshot seq', async () => {
    await insert(0, 'message', { text: 'before' }, 0);
    await insert(1, 'message', { text: 'after the click' }, 1);

    const page = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 0, sourceWorking: false },
      { view: 'items' },
    );
    const item = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 0, sourceWorking: false },
      { view: 'item', seq: 1 },
    );

    expect((page.items as { seq: number }[]).map((row) => row.seq)).toEqual([
      0,
    ]);
    expect(item.error).toBe('PAST_SNAPSHOT');
  });

  it('pages items under the byte budget and continues from the cursor', async () => {
    const long = 'x'.repeat(ITEM_TEXT_CHARS * 2);
    for (let seq = 0; seq < 30; seq += 1) {
      await insert(seq, 'message', { text: `${seq} ${long}` }, seq);
    }

    const first = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 29, sourceWorking: false },
      { view: 'items' },
    );
    const rows = first.items as { seq: number; text: string }[];
    const next = first.next as { afterSeq: number };
    const second = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 29, sourceWorking: false },
      { view: 'items', afterSeq: next.afterSeq },
    );

    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
      PAGE_BYTES,
    );
    expect(rows.length).toBeLessThan(30);
    expect(rows[0]!.text).toContain('view=item seq=0');
    expect((second.items as { seq: number }[])[0]!.seq).toBe(next.afterSeq + 1);
  });

  it('collapses a base64 image and masks a registered secret in one row', async () => {
    registerSecret('sk-live-0123456789abcdef', 'api key');
    await insert(
      0,
      'tool_result',
      {
        id: 't1',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'A'.repeat(4096),
            },
          },
          { type: 'text', text: 'token sk-live-0123456789abcdef' },
        ],
      },
      0,
    );

    const item = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 0, sourceWorking: false },
      { view: 'item', seq: 0 },
    );

    expect(item.text).toContain('[image: image/png, 3 KB]');
    expect(item.text).not.toContain('AAAA');
    expect(item.text).not.toContain('sk-live-0123456789abcdef');
  });

  it('reads one long row in chunks that each fit a page', async () => {
    await insert(0, 'message', { text: 'y'.repeat(PAGE_BYTES * 2) }, 0);

    const first = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 0, sourceWorking: false },
      { view: 'item', seq: 0 },
    );
    const next = first.next as { offset: number };
    const second = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 0, sourceWorking: false },
      { view: 'item', seq: 0, offset: next.offset },
    );

    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
      PAGE_BYTES,
    );
    const joined = `${first.text as string}${second.text as string}`;
    expect(first.total).toBe(PAGE_BYTES * 2);
    expect(joined).toBe('y'.repeat(joined.length));
    expect(joined.length).toBeGreaterThan(PAGE_BYTES);
  });

  it('pages slow tools as spans and continues from the cursor', async () => {
    await insert(0, 'message', { text: 'go' }, 0);
    let seq = 1;
    const name = (index: number): string =>
      `${String(index).padStart(4, '0')}-${'n'.repeat(76)}`;
    for (let index = 0; index < 300; index += 1) {
      await insert(
        seq,
        'tool_call',
        { id: `t${index}`, name: name(index) },
        index,
      );
      await insert(
        seq + 1,
        'tool_result',
        { id: `t${index}` },
        index + (index % 2 === 0 ? 30 : 1),
      );
      seq += 2;
    }
    const source = {
      sourceRunId: 'source',
      snapshotSeq: seq - 1,
      sourceWorking: false,
    };
    const read = (cursor?: number) =>
      reader.read(source, {
        view: 'spans',
        kinds: ['tool'],
        minMs: 10_000,
        ...(cursor === undefined ? {} : { cursor }),
      });

    const first = await read();
    const firstSpans = first.spans as {
      type: string;
      ms: number;
      name: string;
    }[];
    const next = first.next as { cursor: number };
    const second = await read(next.cursor);
    const secondSpans = second.spans as { name: string }[];

    expect(first.total).toBe(150);
    expect(
      firstSpans.every((span) => span.type === 'tool' && span.ms >= 10_000),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
      PAGE_BYTES,
    );
    expect(next.cursor).toBe(firstSpans.length);
    expect(second.from).toBe(next.cursor);
    // The page picks up exactly where the first one stopped.
    const lastIndex = Number(firstSpans.at(-1)!.name.slice(0, 4));
    expect(Number(secondSpans[0]!.name.slice(0, 4))).toBe(lastIndex + 2);
  });

  it('masks a secret a page clip would have cut, leaving no prefix of it', async () => {
    registerSecret('sk-live-0123456789abcdef', 'api key');
    await insert(
      0,
      'message',
      {
        text: `${'x'.repeat(ITEM_TEXT_CHARS - 5)}sk-live-0123456789abcdef tail`,
      },
      0,
    );

    const page = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 0, sourceWorking: false },
      { view: 'items' },
    );
    const text = (page.items as { text: string }[])[0]!.text;

    expect(text).not.toContain('sk-li');
  });

  it('says there is more when the read limit, not the byte budget, ended the page', async () => {
    for (let seq = 0; seq < 50; seq += 1) {
      await insert(seq, 'message', { text: `m${seq}` }, seq);
    }

    const page = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 49, sourceWorking: false },
      { view: 'items' },
    );

    expect((page.items as unknown[]).length).toBe(40);
    expect(page.next).toEqual({ afterSeq: 39 });
  });

  it('draws a tool call left open at the snapshot by the working flag it was taken with', async () => {
    await insert(0, 'message', { text: 'go' }, 0);
    await insert(1, 'tool_call', { id: 't1', name: 'Bash' }, 10);
    await insert(2, 'message', { text: 'still going' }, 70);
    const spans = async (working: boolean) =>
      (
        await reader.read(
          { sourceRunId: 'source', snapshotSeq: 2, sourceWorking: working },
          { view: 'spans', kinds: ['tool'] },
        )
      ).spans as { open: boolean; ms: number }[];

    expect(await spans(true)).toEqual([
      expect.objectContaining({ open: true, ms: 60_000 }),
    ]);
    expect(await spans(false)).toEqual([
      expect.objectContaining({ open: false, ms: 0 }),
    ]);
  });

  it('shortens the overview to its budget and says what it kept', async () => {
    let seq = 0;
    for (let index = 0; index < 400; index += 1) {
      const name = `Tool-${index}-${'q'.repeat(40)}`;
      await insert(seq, 'tool_call', { id: `t${index}`, name }, index);
      await insert(seq + 1, 'tool_result', { id: `t${index}` }, index + 1);
      seq += 2;
    }

    const answer = await reader.read(
      { sourceRunId: 'source', snapshotSeq: seq - 1, sourceWorking: false },
      { view: 'overview' },
    );

    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(
      OVERVIEW_BYTES,
    );
    expect((answer.shortened as Record<string, string>).slowestTools).toMatch(
      /^\d+ of 400$/,
    );
  });

  it('answers SOURCE_GONE once the analysed thread is deleted', async () => {
    const answer = await reader.read(
      { sourceRunId: 'deleted', snapshotSeq: 0, sourceWorking: false },
      { view: 'overview' },
    );

    expect(answer.error).toBe('SOURCE_GONE');
  });
});

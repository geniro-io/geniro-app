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
import { ItemDao } from './item.dao';

/**
 * Real-driver DAO spec: the service specs run in-memory fakes that only MIRROR
 * these queries, so this suite boots MikroORM on an in-memory better-sqlite3
 * database with the real entities and executes the actual SQL — the `$gt`
 * replay cursor, the two-query head reduction, and the run scoping. The config
 * mirrors the daemon's `db/mikro-orm.config.ts` discovery settings, with
 * explicit entity classes in place of the compiled-file glob (so no
 * `dynamicImportProvider` shim is needed).
 */
describe('ItemDao (in-memory sqlite)', () => {
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
    // The module hands each DAO the app-wide EntityManager and per-request work
    // rides a fork (see chat.service) — construct on a fresh fork per test.
    dao = new ItemDao(orm.em.fork());
  });

  /** Persist one row through the DAO's own create — the production write path. */
  async function insert(
    runId: string,
    seq: number,
    kind: ItemKind = 'message',
    payload = JSON.stringify({ text: `m${seq}` }),
  ): Promise<Item> {
    return dao.create({ runId, seq, kind, payload });
  }

  it('finds a send id only on a live user message in its own run', async () => {
    const payload = JSON.stringify({
      text: 'hello',
      clientMessageId: 'phone-1',
    });
    const add = (runId: string, seq: number, role: string, body = payload) =>
      dao.create({ runId, seq, kind: 'message', role, payload: body });
    await add('other-run', 0, 'user');
    await add('run-a', 0, 'assistant');
    const deleted = await add('run-a', 1, 'user');
    await orm.em
      .fork()
      .createQueryBuilder(Item)
      .update({ deletedAt: new Date() })
      .where({ id: deleted.id })
      .execute();
    await add('run-a', 2, 'user', 'invalid json');
    const expected = await add(
      'run-a',
      3,
      'user',
      JSON.stringify({ text: 'hello' }),
    );
    expect(await dao.userMessageByClientId('run-a', 'phone-1')).toBeNull();
    const accepted = await dao.acknowledgeUserMessage(
      'run-a',
      expected.id,
      'phone-1',
    );
    expect(JSON.parse(accepted.payload)).toEqual({
      text: 'hello',
      clientMessageId: 'phone-1',
    });
    expect((await dao.userMessageByClientId('run-a', 'phone-1'))?.id).toBe(
      expected.id,
    );
    expect(await dao.userMessageByClientId('run-a', 'missing')).toBeNull();
  });

  describe('getByRun', () => {
    it('selects a root hand-off history before limiting, excluding its callees and incoming calls', async () => {
      const add = (
        seq: number,
        nodeId: string | null,
        kind: ItemKind,
        payload: unknown,
        role: 'user' | null = null,
      ) =>
        dao.create({
          runId: 'run-a',
          seq,
          nodeId,
          kind,
          role,
          payload: JSON.stringify(payload),
        });
      await add(0, null, 'message', { text: 'original task' }, 'user');
      await add(1, 'root', 'tool_result', { text: 'completed work' });
      await add(2, 'root', 'call_started', {
        callId: 'call-1',
        calleeNodeId: 'helper',
      });
      await add(3, 'root', 'message', {
        callId: 'incoming',
        text: 'incoming call',
      });
      await add(4, 'root', 'tool_result', {
        parentToolUseId: 'delegate',
        text: 'delegate',
      });
      await add(5, 'root', 'call_started', {
        callId: 'nested',
        callerConversationId: 'incoming',
      });
      for (let seq = 6; seq < 216; seq += 1) {
        await add(seq, 'helper', 'message', { text: 'busy callee' });
      }
      await insert('another-run', 1);
      expect(
        (await dao.nodePoolContextRows('run-a', 'root')).map((row) => row.seq),
      ).toEqual([0, 1, 2]);
      for (let seq = 216; seq < 426; seq += 1) {
        await add(seq, 'root', 'message', { text: 'recent root work' });
      }
      const recent = await dao.nodePoolContextRows('run-a', 'root');
      expect(recent).toHaveLength(200);
      expect(recent[0]!.seq).toBe(226);
      expect(recent.at(-1)!.seq).toBe(425);
    });

    it('returns the whole transcript in seq order by default', async () => {
      // Inserted deliberately out of order — the ordering must come from the
      // query, not from insertion (rowid) order.
      await insert('run-a', 2);
      await insert('run-a', 0);
      await insert('run-a', 1);

      const items = await dao.getByRun('run-a');

      expect(items.map((i) => i.seq)).toEqual([0, 1, 2]);
    });

    it('treats afterSeq as a STRICT greater-than replay cursor', async () => {
      await insert('run-a', 0);
      await insert('run-a', 1);
      await insert('run-a', 2);

      // seq 1 already rendered → only seq 2 replays ($gt — a $gte regression
      // would re-send seq 1 here).
      expect((await dao.getByRun('run-a', 1)).map((i) => i.seq)).toEqual([2]);
      expect((await dao.getByRun('run-a', 2)).map((i) => i.seq)).toEqual([]);
      // The -1 default covers seq 0 (seq starts at 0, so 0 > -1).
      expect((await dao.getByRun('run-a', -1)).map((i) => i.seq)).toEqual([
        0, 1, 2,
      ]);
    });

    it('takes the NEWEST items when given a window, still in seq order', async () => {
      // REPORTED as "мы должны максимум загружать где-то 1,000 сообщений …
      // чтобы интерфейс не лагал". Measured on a real thread: 7,814 items are
      // 18.9MB where its newest 1,000 are 0.63MB.
      //
      // Both halves matter and they pull opposite ways: the LIMIT has to take
      // the tail of the conversation (a chat opens on what was last said), and
      // the rows have to come back ASCENDING because every reader downstream —
      // the fold, the call/result pairing, the turn scan — is written against a
      // transcript in the order it happened.
      for (let seq = 0; seq < 6; seq += 1) {
        await insert('run-a', seq);
      }

      expect(
        (await dao.getByRun('run-a', -1, undefined, { limit: 2 })).map(
          (i) => i.seq,
        ),
      ).toEqual([4, 5]);
    });

    it('takes the OLDEST items after afterSeq with take: oldest — the forward page', async () => {
      // A reader who jumped to a conversation's FIRST message must be able to
      // read on from there. The newest-end window cannot express it: asked for
      // two items after seq 1 it answers the last two of the whole run and
      // skips everything in between.
      for (let seq = 0; seq < 6; seq += 1) {
        await insert('run-a', seq);
      }

      expect(
        (
          await dao.getByRun('run-a', 1, undefined, {
            limit: 2,
            take: 'oldest',
          })
        ).map((i) => i.seq),
      ).toEqual([2, 3]);
      expect(
        (await dao.getByRun('run-a', 1, undefined, { limit: 2 })).map(
          (i) => i.seq,
        ),
      ).toEqual([4, 5]);
    });

    it('pages BACKWARDS with beforeSeq, and runs out at the start', async () => {
      for (let seq = 0; seq < 5; seq += 1) {
        await insert('run-a', seq);
      }

      const page = (before: number): Promise<number[]> =>
        dao
          .getByRun('run-a', -1, undefined, { limit: 2, beforeSeq: before })
          .then((rows) => rows.map((i) => i.seq));

      expect(await page(5)).toEqual([3, 4]);
      expect(await page(3)).toEqual([1, 2]);
      // A SHORT page is how the client learns it has reached the beginning —
      // there is no separate "hasMore" on the wire, so this is the signal.
      expect(await page(1)).toEqual([0]);
      expect(await page(0)).toEqual([]);
    });

    it('scopes a window to its own run, like every other read here', async () => {
      await insert('run-a', 0);
      await insert('run-b', 1);
      await insert('run-a', 2);

      expect(
        (await dao.getByRun('run-a', -1, undefined, { limit: 5 })).map(
          (i) => i.seq,
        ),
      ).toEqual([0, 2]);
    });

    it("never leaks another run's items", async () => {
      await insert('run-a', 0);
      await insert('run-b', 0);
      await insert('run-b', 1);

      const items = await dao.getByRun('run-b');

      expect(items.map((i) => i.runId)).toEqual(['run-b', 'run-b']);
      expect(items.map((i) => i.seq)).toEqual([0, 1]);
    });
  });

  describe('maxSeq', () => {
    it('returns the highest seq persisted for the run, scoped to that run', async () => {
      await insert('run-a', 0);
      await insert('run-a', 5);
      await insert('run-a', 3);
      await insert('run-b', 9);

      expect(await dao.maxSeq('run-a')).toBe(5);
    });

    it('returns the -1 sentinel for a run with no items yet', async () => {
      await insert('run-b', 0);

      expect(await dao.maxSeq('run-a')).toBe(-1);
    });
  });

  describe('latestMessageTextPerRun', () => {
    it('previews the ROOT conversation of a workflow run, not a callee inside a call', async () => {
      // REPORTED as a Dev Team row previewing the Engineer's "Fixed: 36/36…"
      // over the Manager's own words.
      await insert(
        'run-a',
        0,
        'message',
        JSON.stringify({ text: 'Manager: launching the Engineer' }),
      );
      await insert(
        'run-a',
        1,
        'message',
        JSON.stringify({ text: 'Fixed: 36/36', callId: 'call-13' }),
      );

      expect((await dao.latestMessageTextPerRun(['run-a'])).get('run-a')).toBe(
        'Manager: launching the Engineer',
      );
    });

    it('previews the text of the highest-seq message item, per run', async () => {
      // Head row inserted FIRST so a "last row processed wins" reduction would
      // be caught too, not just a min/max mixup.
      await insert('run-a', 2, 'message', JSON.stringify({ text: 'a-latest' }));
      await insert('run-a', 0, 'message', JSON.stringify({ text: 'a-first' }));
      await insert('run-b', 0, 'message', JSON.stringify({ text: 'b-only' }));

      const previews = await dao.latestMessageTextPerRun(['run-a', 'run-b']);

      expect(previews.get('run-a')).toBe('a-latest');
      expect(previews.get('run-b')).toBe('b-only');
      expect(previews.size).toBe(2);
    });

    it('skips a DELEGATE’s message — the preview is the parent thread’s', async () => {
      // REPORTED as "last message in thread card is incorrect - maybe it's
      // from subagent?". A delegate's messages are ordinary `message` rows on
      // the run, so the newest message of a fanned-out turn is routinely one
      // of theirs — and the sidebar previewed a conversation its row cannot
      // even open. The delegate's row is the HIGHEST seq here, so a dropped
      // filter surfaces as its text winning rather than as a lucky pass.
      await insert('run-a', 0, 'message', JSON.stringify({ text: 'parent' }));
      await insert(
        'run-a',
        1,
        'message',
        JSON.stringify({ text: 'delegate', parentToolUseId: 'toolu_01' }),
      );

      const previews = await dao.latestMessageTextPerRun(['run-a']);

      expect(previews.get('run-a')).toBe('parent');
    });

    it('reduces over MESSAGE items only — trailing non-message items do not hide the preview', async () => {
      await insert('run-a', 0, 'message', JSON.stringify({ text: 'hello' }));
      // Non-message payloads carry no `text`, so a dropped kind filter would
      // surface as an absent preview here, not a lucky pass.
      await insert('run-a', 1, 'tool_call', JSON.stringify({ name: 'ls' }));
      await insert(
        'run-a',
        2,
        'turn_complete',
        JSON.stringify({ status: 'completed' }),
      );

      const previews = await dao.latestMessageTextPerRun(['run-a']);

      expect(previews.get('run-a')).toBe('hello');
    });

    it('omits runs with no message items', async () => {
      await insert('run-a', 0, 'tool_call', JSON.stringify({ name: 'ls' }));
      await insert('run-b', 0, 'message', JSON.stringify({ text: 'b' }));

      const previews = await dao.latestMessageTextPerRun(['run-a', 'run-b']);

      expect(previews.has('run-a')).toBe(false);
      expect(previews.get('run-b')).toBe('b');
    });

    it('omits a run whose head message has no text — never falls back to an earlier message', async () => {
      await insert('run-a', 0, 'message', JSON.stringify({ text: 'early' }));
      await insert('run-a', 1, 'message', JSON.stringify({}));

      const previews = await dao.latestMessageTextPerRun(['run-a']);

      // Only the head row (seq 1) is ever fetched; its payload has no `text`,
      // so the run is simply absent — seq 0's 'early' is never consulted.
      expect(previews.has('run-a')).toBe(false);
    });

    it('labels an image-only newest message as images rather than previewing a blank line', async () => {
      // REPORTED as "Thread doesnt have last message, but other have": the
      // user answered with a screenshot alone, the message was stored with
      // `text: ""`, and the list handed that empty string to the row, which
      // drew no preview line until the agent's next message minutes later.
      await insert('run-a', 0, 'message', JSON.stringify({ text: 'Open it' }));
      await insert(
        'run-a',
        1,
        'message',
        JSON.stringify({
          text: '',
          images: [{ id: 'shot.png', mediaType: 'image/png' }],
        }),
      );
      await insert(
        'run-b',
        0,
        'message',
        JSON.stringify({
          text: '',
          images: [
            { id: 'a.png', mediaType: 'image/png' },
            { id: 'b.png', mediaType: 'image/png' },
          ],
        }),
      );

      const previews = await dao.latestMessageTextPerRun(['run-a', 'run-b']);

      expect(previews.get('run-a')).toBe('🖼 Image');
      expect(previews.get('run-b')).toBe('🖼 2 images');
    });

    it('tolerates a malformed head payload — absent, never a throw', async () => {
      await insert('run-a', 0, 'message', 'not json {');
      await insert('run-b', 0, 'message', JSON.stringify({ text: 'fine' }));

      const previews = await dao.latestMessageTextPerRun(['run-a', 'run-b']);

      expect(previews.has('run-a')).toBe(false);
      expect(previews.get('run-b')).toBe('fine');
    });

    it('previews the USER’s message when it is the newest', async () => {
      // REPORTED as "In thread i cant see last user message. I should see there
      // last AI or USER message". This preferred the AGENT's latest, so a
      // thread showed the previous answer for the whole time it was working on
      // what the user had just asked — stalest exactly when somebody goes
      // looking for the chat they were last in. Restore that preference and
      // this reads `agent reply`.
      await dao.create({
        runId: 'run-a',
        seq: 0,
        kind: 'message',
        role: 'assistant',
        payload: JSON.stringify({ text: 'agent reply' }),
      });
      await dao.create({
        runId: 'run-a',
        seq: 1,
        kind: 'message',
        role: 'user',
        payload: JSON.stringify({ text: 'and now do this' }),
      });

      const previews = await dao.latestMessageTextPerRun(['run-a']);

      expect(previews.get('run-a')).toBe('and now do this');
    });

    it('falls back to the user’s message while the agent has not spoken', async () => {
      // A chat opened moments ago must still preview the question that started
      // it rather than showing an empty line until the first reply lands.
      await dao.create({
        runId: 'run-a',
        seq: 0,
        kind: 'message',
        role: 'user',
        payload: JSON.stringify({ text: 'first question' }),
      });

      const previews = await dao.latestMessageTextPerRun(['run-a']);

      expect(previews.get('run-a')).toBe('first question');
    });

    it('previews a message under ANY role once it is the newest', async () => {
      // The role no longer decides anything, which is what makes this rule
      // robust where the old one needed care: a CLI is free to spell its own
      // role, and the previous rule had to read every unknown spelling as "the
      // agent" or it would demote a reply to "the user is talking". Nothing has
      // to classify a role now — only order it.
      await dao.create({
        runId: 'run-a',
        seq: 0,
        kind: 'message',
        role: 'user',
        payload: JSON.stringify({ text: 'the question' }),
      });
      await dao.create({
        runId: 'run-a',
        seq: 1,
        kind: 'message',
        role: 'model',
        payload: JSON.stringify({ text: 'from the model' }),
      });

      const previews = await dao.latestMessageTextPerRun(['run-a']);

      expect(previews.get('run-a')).toBe('from the model');
    });

    it('answers for a chat list longer than SQLite’s expression-depth limit', async () => {
      // The head read must not put one OR term per run into a single WHERE:
      // SQLite refuses an OR chain deeper than 1,000 terms outright, which
      // reads as a 500 on the chat list and an empty sidebar. 1,201
      // runs cross that limit AND put a slice boundary mid-list, so a head
      // dropped between two reads shows up as a missing preview. Written in
      // one batched insert: a create per row makes this the slowest spec here.
      const runIds = Array.from({ length: 1_201 }, (_, i) => `run-${i}`);
      const at = new Date(1_000);
      await orm.em.fork().insertMany(
        Item,
        runIds.flatMap((runId, i) => [
          {
            id: `${runId}-0`,
            runId,
            seq: 0,
            kind: 'message' as const,
            role: 'user',
            payload: JSON.stringify({ text: `asked ${i}` }),
            createdAt: at,
            updatedAt: at,
          },
          {
            id: `${runId}-1`,
            runId,
            seq: 1,
            kind: 'message' as const,
            role: 'assistant',
            payload: JSON.stringify({ text: `answered ${i}` }),
            createdAt: at,
            updatedAt: at,
          },
        ]),
      );

      const previews = await dao.latestMessageTextPerRun(runIds);

      expect(previews).toEqual(
        new Map(runIds.map((runId, i) => [runId, `answered ${i}`])),
      );
    });

    it('scopes to the requested runIds; an empty request yields an empty map', async () => {
      await insert('run-a', 0, 'message', JSON.stringify({ text: 'a' }));
      await insert('run-c', 0, 'message', JSON.stringify({ text: 'c' }));

      const previews = await dao.latestMessageTextPerRun(['run-a']);
      expect([...previews.keys()]).toEqual(['run-a']);

      expect((await dao.latestMessageTextPerRun([])).size).toBe(0);
    });
  });

  describe('runPreviews', () => {
    it('dates each run by its NEWEST row, of any kind, beside its preview line', async () => {
      // The sidebar's last activity. A tool row after the last message is
      // still the conversation doing something, so it is not the message that
      // dates it — and a run with no rows at all has no activity to report.
      await dao.create({
        runId: 'run-a',
        seq: 0,
        kind: 'message',
        payload: JSON.stringify({ text: 'hello' }),
        createdAt: new Date(1_000),
      });
      await dao.create({
        runId: 'run-a',
        seq: 1,
        kind: 'tool_call',
        payload: JSON.stringify({ id: 't1', name: 'Bash', input: {} }),
        createdAt: new Date(5_000),
      });

      const previews = await dao.runPreviews(['run-a', 'run-empty']);

      expect(previews.get('run-a')).toEqual({
        lastMessage: 'hello',
        lastActivityAt: new Date(5_000),
      });
      expect(previews.get('run-empty')).toEqual({
        lastMessage: null,
        lastActivityAt: null,
      });
    });
  });

  describe('usagePayloads', () => {
    it('takes only the turn_complete rows, and only this run’s', async () => {
      // The kind filter and the run scoping are the whole query, and neither
      // ever executed against a real driver: the metrics service stubs this
      // method wholesale. A regression yields an empty list, which `sumTurns`
      // turns into `turns: 0` with every figure null — the shape its own doc
      // block defines as "not measured", so a broken query is indistinguishable
      // from a CLI that reports no usage.
      await insert('run-a', 0, 'message', JSON.stringify({ text: 'hello' }));
      await insert(
        'run-a',
        1,
        'turn_complete',
        JSON.stringify({ usage: { costUsd: 0.1 } }),
      );
      await insert('run-a', 2, 'tool_call', JSON.stringify({ name: 'ls' }));
      await insert(
        'run-a',
        3,
        'turn_complete',
        JSON.stringify({ usage: { costUsd: 0.2 } }),
      );
      await insert(
        'run-b',
        0,
        'turn_complete',
        JSON.stringify({ usage: { costUsd: 99 } }),
      );

      const payloads = await dao.usagePayloads('run-a');

      expect(payloads.map((raw) => JSON.parse(raw))).toEqual([
        { usage: { costUsd: 0.1 } },
        { usage: { costUsd: 0.2 } },
      ]);
      // Deliberately NOT asserted: that the rows come back ascending by seq.
      // `sumTurns` adds them, so it is order-independent — an assertion on the
      // order would pin nothing and read as though it did.
    });

    it('takes the error row of a turn that FAILED after spending too', async () => {
      // A session limit ends a turn in an `error` whose payload carries what
      // the turn spent; selecting `turn_complete` alone left that out of every
      // total. An error that spent nothing carries no `usage` and adds nothing.
      await insert(
        'run-a',
        0,
        'turn_complete',
        JSON.stringify({ usage: { costUsd: 1.18 } }),
      );
      await insert(
        'run-a',
        1,
        'error',
        JSON.stringify({
          message: "You've hit your session limit",
          usage: { costUsd: 56.69 },
        }),
      );

      const payloads = await dao.usagePayloads('run-a');

      expect(payloads.map((raw) => JSON.parse(raw))).toContainEqual({
        message: "You've hit your session limit",
        usage: { costUsd: 56.69 },
      });
    });

    it('answers an empty list for a run that has completed no turns', async () => {
      await insert(
        'run-a',
        0,
        'message',
        JSON.stringify({ text: 'still going' }),
      );

      expect(await dao.usagePayloads('run-a')).toEqual([]);
    });
  });

  describe('turnSpanRows', () => {
    it('reads the turn, card and background rows of this run, in seq order', async () => {
      // A projection missing the card or background rows leaves every wait on
      // the clock, with nothing failing.
      const kinds: ItemKind[] = [
        'status',
        'message',
        'approval_request',
        'tool_call',
        'shell_open',
        'subagent_info',
        'shell_info',
        'approval_verdict',
        'unanswerable',
        'turn_complete',
      ];
      for (const [seq, kind] of kinds.entries()) {
        await insert('run-a', seq, kind, JSON.stringify({ id: `r${seq}` }));
      }
      await insert('run-b', 0, 'approval_request', JSON.stringify({ id: 'x' }));

      const rows = await dao.turnSpanRows('run-a');

      expect(rows.map((row) => row.kind)).toEqual([
        'status',
        'approval_request',
        'shell_open',
        'subagent_info',
        'shell_info',
        'approval_verdict',
        'unanswerable',
        'turn_complete',
      ]);
    });

    it('projects a card down to its id and call, keeps its time, and skips a deleted one', async () => {
      // A request carries the plan or patch it asks about; the fold reads two
      // fields of it on every totals read.
      const card = await dao.create({
        runId: 'run-a',
        seq: 0,
        kind: 'approval_request',
        nodeId: 'qa',
        payload: JSON.stringify({
          id: 'q1',
          callId: 'c1',
          input: { plan: 'x'.repeat(5000) },
        }),
      });
      const deleted = await insert(
        'run-a',
        1,
        'approval_request',
        JSON.stringify({ id: 'q2' }),
      );
      await orm.em
        .fork()
        .createQueryBuilder(Item)
        .update({ deletedAt: new Date() })
        .where({ id: deleted.id })
        .execute();
      await insert('run-a', 2, 'unanswerable', 'not json');

      const rows = await dao.turnSpanRows('run-a');

      expect(rows.map((row) => [row.kind, JSON.parse(row.payload)])).toEqual([
        ['approval_request', { id: 'q1', callId: 'c1' }],
        ['unanswerable', { id: null, callId: null }],
      ]);
      expect(rows[0]!.createdAt.getTime()).toBe(card.createdAt.getTime());
      expect(rows[0]!.nodeId).toBe('qa');
    });
  });

  describe('usageRowsWithNode', () => {
    it('takes this run’s turn_complete rows WITH the node that wrote each', async () => {
      // The node is what a workflow's per-agent spend is grouped by; a
      // projection that dropped it would file every turn under no agent.
      await dao.create({
        runId: 'run-a',
        seq: 0,
        kind: 'turn_complete',
        nodeId: 'engineer',
        payload: JSON.stringify({ callId: 'call-1', usage: { costUsd: 1 } }),
      });
      await insert('run-a', 1, 'message');
      await insert(
        'run-b',
        0,
        'turn_complete',
        JSON.stringify({ usage: { costUsd: 99 } }),
      );

      const rows = await dao.usageRowsWithNode('run-a');

      expect(
        rows.map((row) => ({
          nodeId: row.nodeId,
          payload: JSON.parse(row.payload) as unknown,
        })),
      ).toEqual([
        {
          nodeId: 'engineer',
          payload: { callId: 'call-1', usage: { costUsd: 1 } },
        },
      ]);
    });
  });

  describe('firstUserMessageText', () => {
    /** One message row with an explicit role — what the title read filters on. */
    async function say(
      runId: string,
      seq: number,
      role: string,
      text: string,
    ): Promise<void> {
      await dao.create({
        runId,
        seq,
        kind: 'message',
        role,
        payload: JSON.stringify({ text }),
      });
    }

    it('answers with the opening user message, not the newest one', async () => {
      // Out of insertion order on purpose: the ordering must come from the
      // query. A title that tracked the LATEST message would rewrite the
      // sidebar row under the user at every turn, which is the whole reason
      // this is the mirror image of `latestMessageTextPerRun`.
      await say('run-a', 2, 'user', 'and one more thing');
      await say('run-a', 0, 'user', 'add auto chat titles');
      await say('run-a', 1, 'assistant', 'on it');

      expect(await dao.firstUserMessageText('run-a')).toBe(
        'add auto chat titles',
      );
    });

    it('ignores an assistant message that precedes the user’s', async () => {
      await say('run-a', 0, 'assistant', 'imported history');
      await say('run-a', 1, 'user', 'carry on from here');

      expect(await dao.firstUserMessageText('run-a')).toBe(
        'carry on from here',
      );
    });

    it('ignores non-message rows carrying earlier seqs', async () => {
      await dao.create({
        runId: 'run-a',
        seq: 0,
        kind: 'system',
        role: null,
        payload: JSON.stringify({ text: 'session imported' }),
      });
      await say('run-a', 1, 'user', 'the real opening line');

      expect(await dao.firstUserMessageText('run-a')).toBe(
        'the real opening line',
      );
    });

    it('answers null for a run with no user message yet', async () => {
      await say('run-a', 0, 'assistant', 'nothing was asked');

      expect(await dao.firstUserMessageText('run-a')).toBeNull();
    });

    it('answers null for a payload carrying no text', async () => {
      await dao.create({
        runId: 'run-a',
        seq: 0,
        kind: 'message',
        role: 'user',
        payload: JSON.stringify({ images: [{ id: 'i1' }] }),
      });

      expect(await dao.firstUserMessageText('run-a')).toBeNull();
    });

    it("never reads another run's opening message", async () => {
      await say('run-b', 0, 'user', 'a different conversation');

      expect(await dao.firstUserMessageText('run-a')).toBeNull();
    });
  });

  /**
   * The transcript search, against the real driver.
   *
   * Its service spec runs a hand-written double whose `searchByText` ignores the
   * terms it is handed and returns a fixed slice — so it pins the service's
   * plumbing and asserts nothing whatever about the predicate. Everything below
   * is the part only real SQL can answer.
   */
  describe('searchByText', () => {
    /** A row carrying the lowercased index form the write path stores. */
    async function indexed(
      runId: string,
      seq: number,
      searchText: string,
    ): Promise<void> {
      await dao.create({
        runId,
        seq,
        kind: 'message',
        payload: JSON.stringify({ text: searchText }),
        searchText,
      });
    }

    it('AND-s the terms, so more words narrow rather than widen', async () => {
      // The regression this exists for: `$and` widened to `$or` returns both
      // rows, and the service spec's double stays green either way because it
      // never reads the terms at all.
      //
      // The second row carries ONE of the two terms and not the other — which
      // is the whole discriminating power of this case. With two rows that each
      // match both terms or neither, `$or` returns the same set as `$and` and
      // the test passes against the regression it names.
      await indexed('run-a', 0, 'sizing the bloom filter');
      await indexed('run-a', 1, 'a kalman filter, no relation');

      const hits = await dao.searchByText('run-a', ['bloom', 'filter'], 50);

      expect(hits.map((hit) => hit.seq)).toEqual([0]);
    });

    it('answers the NEWEST matches first', async () => {
      await indexed('run-a', 0, 'bloom filter, first mention');
      await indexed('run-a', 1, 'bloom filter, second mention');

      const hits = await dao.searchByText('run-a', ['bloom'], 50);

      expect(hits.map((hit) => hit.seq)).toEqual([1, 0]);
    });

    it('carries the PAYLOAD, which the snippet is cut from', async () => {
      // The projection is a `fields` list; dropping `payload` from it would
      // leave every hit with an empty quote and no test would notice.
      await indexed('run-a', 0, 'sizing the bloom filter');

      expect(await dao.searchByText('run-a', ['bloom'], 50)).toEqual([
        expect.objectContaining({ payload: expect.any(String) }),
      ]);
    });

    it('honours the limit, and never leaves the run', async () => {
      await indexed('run-a', 0, 'bloom one');
      await indexed('run-a', 1, 'bloom two');
      await indexed('run-b', 2, 'bloom elsewhere');

      expect(await dao.searchByText('run-a', ['bloom'], 1)).toHaveLength(1);
      expect(await dao.searchByText('run-a', ['bloom'], 50)).toHaveLength(2);
    });

    it('matches a row the index holds and skips one it does not', async () => {
      // A row written before the column existed carries null, and must simply
      // not match — never throw, and never match everything.
      await indexed('run-a', 0, 'sizing the bloom filter');
      await insert('run-a', 1);

      expect(await dao.searchByText('run-a', ['bloom'], 50)).toHaveLength(1);
    });
  });

  describe('the timeline pair', () => {
    /** A message row with a role — the timeline's whole discriminator. */
    async function say(
      runId: string,
      seq: number,
      role: string,
      text: string,
    ): Promise<void> {
      await dao.create({
        runId,
        seq,
        kind: 'message',
        role,
        payload: JSON.stringify({ text }),
      });
    }

    it('gives the spine every row of the run, and none of their payloads', async () => {
      // The PROJECTION is the whole reason this method exists rather than
      // `getByRun`: `payload` is the TEXT column and a long transcript is most
      // of the database, so a lost `fields` list loads every diff and tool
      // result in the run to answer a question about none of them. The service
      // spec's fake DAO cannot catch that — it hands back whatever it was
      // given.
      await say('run-a', 0, 'user', 'the ask');
      await say('run-a', 1, 'assistant', 'the reply');
      await insert('run-a', 2, 'tool_call', JSON.stringify({ name: 'ls' }));
      await dao.create({
        runId: 'run-a',
        seq: 3,
        kind: 'message',
        role: 'user',
        nodeId: 'engineer',
        payload: JSON.stringify({ text: 'to the callee' }),
      });
      await say('run-b', 0, 'user', 'another run');

      const spine = await dao.timelineSpine('run-a');

      // `nodeId` is what tells a message to the thread from one sent straight
      // to a workflow callee, so the projection has to carry it.
      expect(
        spine.map((row) => [row.seq, row.kind, row.role, row.nodeId]),
      ).toEqual([
        [0, 'message', 'user', null],
        [1, 'message', 'assistant', null],
        [2, 'tool_call', null, null],
        [3, 'message', 'user', 'engineer'],
      ]);
      // Loaded, it would be the message text — so this goes red on a widened
      // projection rather than merely on a missing column.
      for (const row of spine) {
        expect((row as Partial<Item>).payload).toBeUndefined();
      }
    });

    it('takes only USER messages and finished turns into the payload read', async () => {
      // The `$or` is what bounds the expensive half of the pair. An arm lost to
      // a widened OR reads every agent message's payload too, and one lost to a
      // dropped `runId` reads another conversation's — neither of which fails
      // anything the service spec asserts.
      await say('run-a', 0, 'user', 'the ask');
      await say('run-a', 1, 'assistant', 'the reply');
      await insert(
        'run-a',
        2,
        'turn_complete',
        JSON.stringify({ usage: { costUsd: 0.1 } }),
      );
      await insert('run-a', 3, 'tool_result', JSON.stringify({ out: 'x' }));
      await say('run-b', 0, 'user', 'another run');

      const rows = await dao.timelinePayloadRows('run-a');

      expect(rows.map((row) => [row.seq, row.kind])).toEqual([
        [0, 'message'],
        [2, 'turn_complete'],
      ]);
      expect(JSON.parse(rows[0]!.payload)).toEqual({ text: 'the ask' });
    });

    it('orders both reads by seq, which is what the fold walks', async () => {
      // The fold is two forward walks over these two lists and advances a
      // pointer through the second. Insertion (rowid) order here is deliberately
      // the reverse, so an ordering that came from the table rather than the
      // query files every turn against the wrong segment.
      await insert(
        'run-a',
        4,
        'turn_complete',
        JSON.stringify({ usage: { costUsd: 0.2 } }),
      );
      await say('run-a', 3, 'user', 'second ask');
      await insert(
        'run-a',
        2,
        'turn_complete',
        JSON.stringify({ usage: { costUsd: 0.1 } }),
      );
      await say('run-a', 1, 'user', 'first ask');

      expect((await dao.timelineSpine('run-a')).map((r) => r.seq)).toEqual([
        1, 2, 3, 4,
      ]);
      expect(
        (await dao.timelinePayloadRows('run-a')).map((r) => r.seq),
      ).toEqual([1, 2, 3, 4]);
    });
  });

  describe('userMessagesInOrder', () => {
    it('reads the live user messages oldest first, whatever order they were written in', async () => {
      const add = (seq: number, role: string) =>
        dao.create({
          runId: 'run-a',
          seq,
          kind: 'message',
          role,
          payload: JSON.stringify({ text: `m${seq}` }),
        });
      await add(7, 'user');
      await add(2, 'user');
      await add(5, 'assistant');
      const deleted = await add(9, 'user');
      await orm.em
        .fork()
        .createQueryBuilder(Item)
        .update({ deletedAt: new Date() })
        .where({ id: deleted.id })
        .execute();

      const rows = await dao.userMessagesInOrder('run-a');

      expect(rows.map((row) => row.seq)).toEqual([2, 7]);
    });
  });

  describe('existingSeqs', () => {
    it('answers only the seqs the run holds at or below the snapshot', async () => {
      await insert('run-a', 1);
      await insert('run-a', 4);
      await insert('run-a', 9);
      await insert('run-b', 2);

      const found = await dao.existingSeqs('run-a', [1, 2, 4, 9], 5);

      expect([...found].sort((a, b) => a - b)).toEqual([1, 4]);
    });
  });

  describe('toolCallTimes', () => {
    it('reads the id and name of each tool row up to the snapshot, and nothing it said', async () => {
      await insert(
        'run-a',
        0,
        'tool_call',
        JSON.stringify({ id: 't1', name: 'Bash', input: { command: 'ls' } }),
      );
      await insert('run-a', 1, 'message');
      await insert(
        'run-a',
        2,
        'tool_result',
        JSON.stringify({ id: 't1', output: 'secret listing' }),
      );
      await insert('run-a', 3, 'tool_call', 'not json');
      await insert('run-a', 4, 'tool_call', JSON.stringify({ id: 't2' }));
      await insert(
        'run-a',
        5,
        'tool_call',
        JSON.stringify({ id: 't3', name: 'Read', parentToolUseId: 'toolu_a' }),
      );
      await insert('run-b', 0, 'tool_call', JSON.stringify({ id: 'x' }));

      const rows = await dao.toolCallTimes('run-a', 3);

      expect(
        rows.map(({ seq, kind, toolId, name, delegate }) => ({
          seq,
          kind,
          toolId,
          name,
          delegate,
        })),
      ).toEqual([
        {
          seq: 0,
          kind: 'tool_call',
          toolId: 't1',
          name: 'Bash',
          delegate: false,
        },
        {
          seq: 2,
          kind: 'tool_result',
          toolId: 't1',
          name: null,
          delegate: false,
        },
        {
          seq: 3,
          kind: 'tool_call',
          toolId: null,
          name: null,
          delegate: false,
        },
      ]);
      expect(
        (await dao.toolCallTimes('run-a', 5)).at(-1)?.delegate,
        'a sub-agent call is marked',
      ).toBe(true);
      expect(typeof rows[0]!.at).toBe('number');
      expect(rows[2]!.at).toBeGreaterThanOrEqual(rows[0]!.at);
    });

    it('reads a result the CLI marked as an error, and only a result', async () => {
      await insert(
        'run-a',
        0,
        'tool_call',
        JSON.stringify({ id: 't1', name: 'Bash', isError: true }),
      );
      await insert(
        'run-a',
        1,
        'tool_result',
        JSON.stringify({ id: 't1', isError: true }),
      );
      await insert(
        'run-a',
        2,
        'tool_result',
        JSON.stringify({ id: 't2', isError: false }),
      );
      await insert('run-a', 3, 'tool_result', JSON.stringify({ id: 't3' }));

      const rows = await dao.toolCallTimes('run-a', 3);

      expect(rows.map((row) => row.isError)).toEqual([
        false,
        true,
        false,
        false,
      ]);
    });
  });

  describe('waterfallPayloadRows', () => {
    it('stops at the snapshot seq it is given', async () => {
      await insert('run-a', 0, 'turn_complete', JSON.stringify({ usage: {} }));
      await insert('run-a', 5, 'turn_complete', JSON.stringify({ usage: {} }));

      const rows = await dao.waterfallPayloadRows('run-a', undefined, 4);

      expect(rows.map((row) => row.seq)).toEqual([0]);
      expect(
        (await dao.timelineSpine('run-a', undefined, 4)).map((row) => row.seq),
      ).toEqual([0]);
    });

    it('leaves tool calls and results out, which is what makes the read affordable', async () => {
      // The exclusion IS the design: tool rows outnumber every other kind by
      // orders of magnitude, and the waterfall draws them as a density that
      // `timelineSpine`'s projection already answers. Widen this `$in` and the
      // route starts loading thousands of tool payloads per run to draw a
      // picture that reads none of them — which nothing else in the suite sees,
      // because the fold is handed whatever the fake DAO returns.
      await insert('run-a', 0, 'tool_call', JSON.stringify({ id: 't1' }));
      await insert('run-a', 1, 'tool_result', JSON.stringify({ id: 't1' }));
      await insert(
        'run-a',
        2,
        'turn_complete',
        JSON.stringify({ usage: { costUsd: 0.1 } }),
      );

      const rows = await dao.waterfallPayloadRows('run-a');

      expect(rows.map((row) => row.kind)).toEqual(['turn_complete']);
    });

    it('takes every kind whose span cannot be drawn without its payload', async () => {
      const kinds: ItemKind[] = [
        'turn_complete',
        'subagent_info',
        'call_started',
        'call_result',
        'approval_request',
        'approval_verdict',
      ];
      for (const [index, kind] of kinds.entries()) {
        await insert('run-a', index, kind, JSON.stringify({ k: kind }));
      }

      const rows = await dao.waterfallPayloadRows('run-a');

      // A kind dropped from the `$in` silently deletes a whole lane from the
      // card rather than failing anything.
      expect(rows.map((row) => row.kind)).toEqual(kinds);
    });

    it('carries the node and the instant each row landed at', async () => {
      // Both are load-bearing and neither is in `timelinePayloadRows`: the node
      // picks the LANE, and `createdAt` is the only wall-clock the span has.
      const at = new Date('2026-02-03T04:05:06.000Z');
      await dao.create({
        runId: 'run-a',
        seq: 0,
        kind: 'call_started',
        nodeId: 'manager',
        payload: JSON.stringify({ callId: 'call-1' }),
        createdAt: at,
      });

      const [row] = await dao.waterfallPayloadRows('run-a');

      expect(row?.nodeId).toBe('manager');
      expect(row?.createdAt.getTime()).toBe(at.getTime());
    });

    it('answers for one run only, in seq order', async () => {
      // Inserted in reverse so an ordering that came from the table rather than
      // the query puts every span on the timeline backwards.
      await insert('run-a', 2, 'turn_complete', JSON.stringify({ n: 2 }));
      await insert('run-a', 1, 'call_started', JSON.stringify({ n: 1 }));
      await insert('run-b', 0, 'turn_complete', JSON.stringify({ n: 0 }));

      expect(
        (await dao.waterfallPayloadRows('run-a')).map((r) => r.seq),
      ).toEqual([1, 2]);
    });
  });

  it("reads a run's shell rows in seq order, with the node each was filed under", async () => {
    // What the stranded-command repair folds: the open and the close are both
    // needed, in the order they happened, and the node is where the close has
    // to be filed. Inserted out of order so the ordering has to be the query's.
    await dao.create({
      runId: 'run-a',
      seq: 2,
      kind: 'shell_info',
      nodeId: 'manager',
      payload: JSON.stringify({ id: 't1', workId: 'b1' }),
    });
    await dao.create({
      runId: 'run-a',
      seq: 0,
      kind: 'shell_open',
      nodeId: 'manager',
      payload: JSON.stringify({ id: 't1', workId: 'b1' }),
    });
    await insert('run-a', 1);
    await dao.create({
      runId: 'run-b',
      seq: 0,
      kind: 'shell_open',
      payload: JSON.stringify({ id: 't9', workId: 'b9' }),
    });

    expect(
      (await dao.shellRows('run-a')).map((row) => [row.kind, row.nodeId]),
    ).toEqual([
      ['shell_open', 'manager'],
      ['shell_info', 'manager'],
    ]);
    expect(
      (await dao.allShellRows()).map((row) => [row.runId, row.kind]),
    ).toEqual([
      ['run-a', 'shell_open'],
      ['run-a', 'shell_info'],
      ['run-b', 'shell_open'],
    ]);
  });

  it('reads the named tool calls of one run, in seq order, and nothing else', async () => {
    // What every listing of open commands reads its words from: a shell row
    // names only its launching call.
    const call = (
      runId: string,
      seq: number,
      id: string,
      kind: ItemKind = 'tool_call',
    ) =>
      dao.create({
        runId,
        seq,
        kind,
        nodeId: 'callee',
        payload: JSON.stringify({ id, name: 'Bash', input: { command: id } }),
      });
    await call('run-a', 2, 'toolu_b');
    await call('run-a', 0, 'toolu_a');
    await call('run-a', 1, 'toolu_other');
    await call('run-a', 3, 'toolu_a', 'tool_result');
    await call('run-b', 4, 'toolu_a');

    const ids = (rows: { payload: unknown }[]): unknown[] =>
      rows.map((row) => JSON.parse(String(row.payload)).id);
    expect(
      ids(await dao.toolCallsByIds('run-a', ['toolu_a', 'toolu_b'])),
    ).toEqual(['toolu_a', 'toolu_b']);
    expect(await dao.toolCallsByIds('run-a', [])).toEqual([]);
  });

  it("reads a run's call rows and delivery notices in seq order", async () => {
    // What the call seed folds after a daemon restart: the start (id, parties,
    // the thread it continued) and the result (the callee's session), in the
    // order they happened, so a continuation lands after its parent. Inserted
    // out of order so the ordering has to be the query's, with a row of
    // another kind and another run's call beside them.
    await dao.create({
      runId: 'run-a',
      seq: 3,
      kind: 'call_result',
      nodeId: 'manager',
      payload: JSON.stringify({ callId: 'call-1', sessionId: 'sess-1' }),
    });
    await dao.create({
      runId: 'run-a',
      seq: 0,
      kind: 'call_started',
      nodeId: 'manager',
      payload: JSON.stringify({ callId: 'call-1' }),
    });
    await insert('run-a', 1);
    await dao.create({
      runId: 'run-a',
      seq: 2,
      kind: 'call_question',
      nodeId: 'manager',
      payload: JSON.stringify({ callId: 'call-1' }),
    });
    await dao.create({
      runId: 'run-b',
      seq: 0,
      kind: 'call_started',
      payload: JSON.stringify({ callId: 'call-1' }),
    });
    await dao.create({
      runId: 'run-a',
      seq: 4,
      kind: 'call_answer',
      payload: JSON.stringify({
        outcome: 'undelivered',
        message: 'correction',
      }),
    });
    await dao.create({
      runId: 'run-a',
      seq: 5,
      kind: 'system',
      payload: JSON.stringify({ messageDeliveryNotices: ['delivery-1'] }),
    });
    await dao.create({
      runId: 'run-a',
      seq: 6,
      kind: 'system',
      payload: JSON.stringify({ message: 'unrelated system note' }),
    });

    const rows = await dao.callRecordRows('run-a');
    expect(rows.map((row) => row.kind)).toEqual([
      'call_started',
      'call_result',
      'call_answer',
      'system',
    ]);
    // The column comes back as it is stored — JSON text — which the fold
    // parses for itself.
    expect(rows.map((row) => row.payload)).toEqual([
      JSON.stringify({ callId: 'call-1' }),
      JSON.stringify({ callId: 'call-1', sessionId: 'sess-1' }),
      JSON.stringify({ outcome: 'undelivered', message: 'correction' }),
      JSON.stringify({ messageDeliveryNotices: ['delivery-1'] }),
    ]);
  });

  describe('toolUsage and delegateToolCallSeqs', () => {
    const call = (
      seq: number,
      nodeId: string | null,
      payload: Record<string, unknown> | string,
    ) =>
      dao.create({
        runId: 'run-a',
        seq,
        kind: 'tool_call',
        nodeId,
        payload:
          typeof payload === 'string' ? payload : JSON.stringify(payload),
      });

    beforeEach(async () => {
      await call(0, 'eng', { name: 'Bash', toolKind: 'execute' });
      await call(1, 'eng', { name: 'Bash', toolKind: 'execute' });
      await call(2, 'eng', {
        name: 'Bash',
        toolKind: 'execute',
        parentToolUseId: 'toolu_agent',
      });
      await call(3, 'eng', {
        name: 'Read',
        toolKind: 'read',
        parentToolUseId: 'toolu_agent',
      });
      // A call that names no tool, and a payload that is not JSON at all.
      await call(4, 'eng', { toolKind: 'read' });
      await call(5, 'eng', 'not json');
      await dao.create({
        runId: 'other-run',
        seq: 0,
        kind: 'tool_call',
        nodeId: 'eng',
        payload: JSON.stringify({ name: 'Bash', parentToolUseId: 'x' }),
      });
    });

    it('groups a run’s tool calls per lane, its own apart from its sub-agents’', async () => {
      const groups = await dao.toolUsage('run-a', 10);

      expect(
        groups.sort(
          (a, b) =>
            a.name.localeCompare(b.name) ||
            Number(a.delegate) - Number(b.delegate),
        ),
      ).toEqual([
        {
          nodeId: 'eng',
          name: 'Bash',
          toolKind: 'execute',
          delegate: false,
          calls: 2,
        },
        {
          nodeId: 'eng',
          name: 'Bash',
          toolKind: 'execute',
          delegate: true,
          calls: 1,
        },
        {
          nodeId: 'eng',
          name: 'Read',
          toolKind: 'read',
          delegate: true,
          calls: 1,
        },
      ]);
    });

    it('answers the busiest groups first, up to the limit', async () => {
      const groups = await dao.toolUsage('run-a', 1);
      expect(groups).toEqual([
        {
          nodeId: 'eng',
          name: 'Bash',
          toolKind: 'execute',
          delegate: false,
          calls: 2,
        },
      ]);
    });

    it('lists the seqs of the run’s sub-agent calls, up to a snapshot', async () => {
      expect((await dao.delegateToolCallSeqs('run-a')).sort()).toEqual([2, 3]);
      expect(await dao.delegateToolCallSeqs('run-a', undefined, 2)).toEqual([
        2,
      ]);
    });
  });

  describe('rowsByPayloadId', () => {
    it('reads past a row whose payload is not JSON', async () => {
      await insert('run-ids', 1, 'tool_call', 'not json');
      await insert('run-ids', 2, 'tool_call', JSON.stringify({ id: 'call-1' }));

      const rows = await dao.rowsByPayloadId(
        'run-ids',
        ['tool_call'],
        ['call-1'],
      );

      expect(rows.map((row) => row.seq)).toEqual([2]);
    });
  });

  describe('pullRequestCandidates', () => {
    it('reads only the tool results inside the seq window it is given', async () => {
      const url = JSON.stringify({ result: 'https://github.com/o/r/pull/1' });
      for (const seq of [1, 5, 9]) {
        await insert('run-pr', seq, 'tool_result', url);
      }
      await insert('run-pr', 6, 'tool_result', url);
      await insert('run-pr', 7, 'message', url);

      const window = await dao.pullRequestCandidates('run-pr', 1, undefined, 6);
      const open = await dao.pullRequestCandidates('run-pr', 1);

      // Both edges: the window opens after its first seq and closes on its last.
      expect(window.map((row) => row.seq)).toEqual([5, 6]);
      expect(open.map((row) => row.seq)).toEqual([5, 6, 9]);
    });
  });

  describe('toolResultSeqAt', () => {
    it('answers the newest tool result at or before the moment, else the oldest after, else null', async () => {
      const em = orm.em.fork();
      const rows: [string, string, number, Item['kind'], string][] = [
        ['r-1', 'run-at', 2, 'tool_result', '2026-10-13T20:00:00.000Z'],
        ['r-2', 'run-at', 5, 'tool_result', '2026-10-13T20:36:40.000Z'],
        // Newer in time than the moment, so never the "at or before" answer.
        ['r-3', 'run-at', 9, 'tool_result', '2026-10-13T20:40:00.000Z'],
        // A row of another kind between them is not a tool result.
        ['m-1', 'run-at', 6, 'message', '2026-10-13T20:36:45.000Z'],
        ['o-1', 'run-other', 7, 'tool_result', '2026-10-13T20:36:46.000Z'],
      ];
      for (const [id, runId, seq, kind, at] of rows) {
        await em.getRepository(Item).insert({
          id,
          runId,
          seq,
          kind,
          payload: '{}',
          createdAt: new Date(at),
          updatedAt: new Date(at),
        });
      }

      expect(
        await dao.toolResultSeqAt(
          'run-at',
          new Date('2026-10-13T20:36:47.487Z'),
        ),
      ).toBe(5);
      expect(
        await dao.toolResultSeqAt(
          'run-at',
          new Date('2026-10-13T19:00:00.000Z'),
        ),
      ).toBe(2);
      expect(
        await dao.toolResultSeqAt(
          'run-none',
          new Date('2026-10-13T20:36:47.487Z'),
        ),
      ).toBeNull();
    });
  });

  describe('earliestToolResultTimes', () => {
    it('dates each seq by its earliest tool result, whichever row was written first', async () => {
      const em = orm.em.fork();
      // Two tool results share a seq. The LATER one is written first, so insertion order and
      // time order disagree, and only the time order may decide which one a seq is dated by.
      await em.getRepository(Item).insert({
        id: 'result-written-first',
        runId: 'run-a',
        seq: 4,
        kind: 'tool_result',
        payload: '{}',
        createdAt: new Date('2026-08-10T12:00:00.000Z'),
        updatedAt: new Date('2026-08-10T12:00:00.000Z'),
      });
      await em.getRepository(Item).insert({
        id: 'result-written-second',
        runId: 'run-a',
        seq: 4,
        kind: 'tool_result',
        payload: '{}',
        createdAt: new Date('2026-08-09T12:00:00.000Z'),
        updatedAt: new Date('2026-08-09T12:00:00.000Z'),
      });

      const times = await dao.earliestToolResultTimes('run-a', [4, 7]);

      expect(times.get(4)).toEqual(new Date('2026-08-09T12:00:00.000Z'));
      expect(times.has(7)).toBe(false);
    });
  });

  describe('earliestToolResultTimesOf', () => {
    it('dates captures of several runs in one call, each run kept apart and only tool results counted', async () => {
      const em = orm.em.fork();
      const rows: [string, string, number, Item['kind'], string][] = [
        // run-batch-a seq 4: the tool result written second is the earlier one.
        ['a-late', 'run-batch-a', 4, 'tool_result', '2026-08-12T12:00:00.000Z'],
        [
          'a-early',
          'run-batch-a',
          4,
          'tool_result',
          '2026-08-09T12:00:00.000Z',
        ],
        // The same seq in another run is that run's own row, not run-a's.
        ['b-tool', 'run-batch-b', 4, 'tool_result', '2026-08-13T12:00:00.000Z'],
        // A message sharing run-b's seq 5 cannot date a pull request.
        ['b-message', 'run-batch-b', 5, 'message', '2026-08-13T12:00:00.000Z'],
      ];
      for (const [id, runId, seq, kind, at] of rows) {
        await em.getRepository(Item).insert({
          id,
          runId,
          seq,
          kind,
          payload: '{}',
          createdAt: new Date(at),
          updatedAt: new Date(at),
        });
      }

      const times = await dao.earliestToolResultTimesOf([
        { runId: 'run-batch-a', seq: 4 },
        { runId: 'run-batch-b', seq: 4 },
        { runId: 'run-batch-b', seq: 5 },
        { runId: 'run-batch-c', seq: 4 },
      ]);

      expect(times.get('run-batch-a')).toEqual(
        new Map([[4, new Date('2026-08-09T12:00:00.000Z')]]),
      );
      expect(times.get('run-batch-b')).toEqual(
        new Map([[4, new Date('2026-08-13T12:00:00.000Z')]]),
      );
      expect(times.has('run-batch-c')).toBe(false);
    });

    it('answers every capture when they outnumber one lookup, so no capture is dropped at a chunk edge', async () => {
      const em = orm.em.fork();
      const captures: { runId: string; seq: number }[] = [];
      for (let seq = 0; seq < 205; seq += 1) {
        await em.getRepository(Item).insert({
          id: `chunk-${seq}`,
          runId: 'run-chunk',
          seq,
          kind: 'tool_result',
          payload: '{}',
          createdAt: new Date('2026-08-10T12:00:00.000Z'),
          updatedAt: new Date('2026-08-10T12:00:00.000Z'),
        });
        captures.push({ runId: 'run-chunk', seq });
      }

      const times = await dao.earliestToolResultTimesOf(captures);

      expect(times.get('run-chunk')?.size).toBe(205);
      expect(times.get('run-chunk')?.get(204)).toEqual(
        new Date('2026-08-10T12:00:00.000Z'),
      );
    });
  });
});

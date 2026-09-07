import type { EntityManager } from '@mikro-orm/sqlite';
import { NotFoundException } from '@packages/common';
import { describe, expect, it } from 'vitest';

import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import { ChatTimelineService } from './chat-timeline.service';

interface StoredRow {
  seq: number;
  kind: string;
  role: string | null;
  payload: string;
  createdAt: Date;
}

const T0 = Date.parse('2026-09-07T12:00:00.000Z');

function at(secondsIn: number): Date {
  return new Date(T0 + secondsIn * 1000);
}

function row(
  seq: number,
  kind: string,
  role: string | null,
  payload: unknown,
  secondsIn = 0,
): StoredRow {
  return {
    seq,
    kind,
    role,
    payload: JSON.stringify(payload),
    createdAt: at(secondsIn),
  };
}

function user(seq: number, text: string, secondsIn = 0): StoredRow {
  return row(seq, 'message', 'user', { text }, secondsIn);
}

function agent(seq: number, text: string, secondsIn = 0): StoredRow {
  return row(seq, 'message', 'assistant', { text }, secondsIn);
}

function turn(seq: number, usage: unknown, secondsIn = 0): StoredRow {
  return row(seq, 'turn_complete', null, { usage }, secondsIn);
}

function build(rows: StoredRow[], runExists = true) {
  const service = new ChatTimelineService(
    { fork: () => ({}) } as unknown as EntityManager,
    {
      timelineSpine: () =>
        Promise.resolve(
          rows.map(({ seq, kind, role, createdAt }) => ({
            seq,
            kind,
            role,
            createdAt,
          })),
        ),
      timelinePayloadRows: () =>
        Promise.resolve(
          rows
            .filter(
              (r) =>
                r.kind === 'turn_complete' ||
                (r.kind === 'message' && r.role === 'user'),
            )
            .map(({ seq, kind, payload }) => ({ seq, kind, payload })),
        ),
    } as unknown as ItemDao,
    {
      getById: () => Promise.resolve(runExists ? { id: 'run-1' } : null),
    } as unknown as RunDao,
  );
  return service;
}

describe('ChatTimelineService', () => {
  it('puts one marker on the rail per USER message, and none for the agent', async () => {
    const service = build([
      user(1, 'first ask'),
      agent(2, 'answering'),
      agent(3, 'still answering'),
      user(4, 'second ask'),
      agent(5, 'answering again'),
    ]);

    const { markers } = await service.read('run-1');

    expect(markers.map((m) => m.seq)).toEqual([1, 4]);
    expect(markers.map((m) => m.preview)).toEqual(['first ask', 'second ask']);
  });

  it('counts the agent messages BETWEEN two markers into the earlier one', async () => {
    // The off-by-one that matters: a segment runs from its own user message to
    // the row before the NEXT one, so the second marker's own agent replies
    // must not be billed to the first.
    const service = build([
      user(1, 'first ask'),
      agent(2, 'a'),
      agent(3, 'b'),
      user(4, 'second ask'),
      agent(5, 'c'),
    ]);

    const { markers } = await service.read('run-1');

    expect(markers[0]?.segment.aiMessages).toBe(2);
    expect(markers[1]?.segment.aiMessages).toBe(1);
  });

  it('counts a message the CLI files under some other role as an agent message', async () => {
    // The discriminator is "a message row that is not the user's", matching the
    // renderer's own transcript fold. Narrowing it to role === 'assistant'
    // would drop every row a CLI names differently, and this goes red if it is.
    const service = build([
      user(1, 'ask'),
      row(2, 'message', 'model', { text: 'from a differently-named role' }),
      row(3, 'message', null, { text: 'from no role at all' }),
    ]);

    const { markers } = await service.read('run-1');

    expect(markers[0]?.segment.aiMessages).toBe(2);
  });

  it('measures elapsed time to the LAST row of the stretch, not to the next marker', async () => {
    const service = build([
      user(1, 'ask', 0),
      agent(2, 'reply', 30),
      user(3, 'ask again', 300),
    ]);

    const { markers } = await service.read('run-1');

    expect(markers[0]?.segment.elapsedMs).toBe(30_000);
  });

  it('reports no elapsed time for a marker nothing followed', async () => {
    // A message just sent has no stretch yet. Zero would read as "answered
    // instantly", which is a different and false claim.
    const service = build([user(1, 'just asked')]);

    const { markers } = await service.read('run-1');

    expect(markers[0]?.segment.elapsedMs).toBeNull();
  });

  it('sums the turns of each stretch, and leaves an unpriced one NULL', async () => {
    // cursor turns report no cost. A segment whose turns all reported none must
    // read as not measured — rendering $0.00 there is a claim about money the
    // CLI never made.
    // The first stretch holds TWO turns, which is what makes this a sum rather
    // than a last-one-wins: a delegate reporting back makes the CLI open a
    // further turn under the same user message, so a multi-turn stretch is the
    // routine shape on exactly the longest ones.
    const service = build([
      user(1, 'priced ask'),
      turn(2, { costUsd: 0.25, inputTokens: 100, outputTokens: 20 }),
      turn(3, { costUsd: 0.1, inputTokens: 40 }),
      user(4, 'unpriced ask'),
      turn(5, { inputTokens: 50 }),
    ]);

    const { markers } = await service.read('run-1');

    expect(markers[0]?.segment.totals.costUsd).toBeCloseTo(0.35, 10);
    expect(markers[0]?.segment.totals.inputTokens).toBe(140);
    expect(markers[0]?.segment.totals.turns).toBe(2);
    expect(markers[1]?.segment.totals.costUsd).toBeNull();
    expect(markers[1]?.segment.totals.inputTokens).toBe(50);
  });

  it('leaves rows BEFORE the first user message off the rail entirely', async () => {
    // An imported conversation can open with agent rows. They belong to no
    // marker, and billing them to the first one would attribute work to a
    // message that had not been sent yet.
    const service = build([
      agent(1, 'replayed history'),
      turn(2, { costUsd: 9.99 }),
      user(3, 'the first thing I said'),
      agent(4, 'reply'),
      turn(5, { costUsd: 0.5 }),
    ]);

    const { markers } = await service.read('run-1');

    expect(markers).toHaveLength(1);
    expect(markers[0]?.seq).toBe(3);
    expect(markers[0]?.segment.aiMessages).toBe(1);
    expect(markers[0]?.segment.totals.costUsd).toBe(0.5);
  });

  it('cuts a long preview to a label and marks that it was cut', async () => {
    const service = build([user(1, 'x'.repeat(400))]);

    const { markers } = await service.read('run-1');

    expect(markers[0]?.preview).toHaveLength(120);
    expect(markers[0]?.preview.endsWith('…')).toBe(true);
  });

  it('collapses a multi-line message onto one line', async () => {
    const service = build([user(1, '\n\n# Heading\n\nthen the ask')]);

    const { markers } = await service.read('run-1');

    expect(markers[0]?.preview).toBe('# Heading then the ask');
  });

  it('refuses an unknown run rather than answering an empty rail', async () => {
    // "This conversation does not exist" and "nobody has said anything in it"
    // are different answers, and only the first is a 4xx.
    const service = build([], false);

    await expect(service.read('run-nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('answers an empty rail for a real run that holds nothing', async () => {
    const service = build([]);

    await expect(service.read('run-1')).resolves.toEqual({
      markers: [],
      partialReason: null,
    });
  });

  it('makes no partial claim about a rail that is whole', async () => {
    const service = build([user(1, 'ask'), agent(2, 'reply')]);

    const { partialReason } = await service.read('run-1');

    expect(partialReason).toBeNull();
  });

  it('caps a very long rail, keeps the NEWEST, and says the thread starts earlier', async () => {
    // Truncating silently is the failure the sentence exists to prevent: a
    // shorter rail is otherwise indistinguishable from a shorter conversation.
    // Keeping the newest and holding seq order is what stops the cap turning
    // the thread backwards.
    const rows: StoredRow[] = [];
    for (let i = 1; i <= 260; i += 1) {
      rows.push(user(i, `ask ${i}`));
    }
    const service = build(rows);

    const { markers, partialReason } = await service.read('run-1');

    expect(markers).toHaveLength(200);
    expect(markers[0]?.preview).toBe('ask 61');
    expect(markers[199]?.preview).toBe('ask 260');
    expect(partialReason).toContain('newest 200');
  });
});

import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';

import {
  type ItemWire,
  MILESTONE_RUN_CAP,
  type MilestonePayload,
} from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import { MilestoneBroker, type MilestoneSink } from './milestone.broker';

interface Written {
  memberId: string | null;
  seq: number;
  payload: MilestonePayload;
}

function harness() {
  const written: Written[] = [];
  const itemDao = {
    newestRowsOfKinds: (_runId: string, _kinds: unknown, limit: number) =>
      Promise.resolve(
        written.slice(-limit).map((row) => ({
          seq: row.seq,
          payload: JSON.stringify(row.payload),
        })),
      ),
  } as unknown as ItemDao;
  const broker = new MilestoneBroker(
    { fork: () => ({}) } as unknown as EntityManager,
    itemDao,
  );
  const sink = (
    recorder: MilestoneSink['recorder'] = () => ({
      memberId: 'senior',
      conversationId: null,
      callId: null,
    }),
  ): MilestoneSink => ({
    persistItem: (memberId, _kind, _role, payload) => {
      const seq = written.length + 1;
      written.push({ memberId, seq, payload: payload as MilestonePayload });
      return Promise.resolve({ seq } as ItemWire);
    },
    recorder,
  });
  return { broker, sink, written };
}

describe('MilestoneBroker', () => {
  it('writes a step as a milestone row naming the recording conversation', async () => {
    const { broker, sink, written } = harness();
    broker.register('run', 'senior', sink());

    const outcome = await broker.record('run', 'senior', 'caller', {
      text: 'Found the cause',
      kind: 'problem',
    });

    expect(outcome).toEqual({ status: 'recorded', seq: 1 });
    expect(written).toEqual([
      {
        memberId: 'senior',
        seq: 1,
        payload: {
          text: 'Found the cause',
          kind: 'problem',
          nodeId: 'senior',
          conversationId: null,
        },
      },
    ]);
  });

  it("files a callee's step under the call its conversation answers", async () => {
    const { broker, sink, written } = harness();
    broker.register(
      'run',
      'middle',
      sink(() => ({
        memberId: 'middle',
        conversationId: 'conv-1',
        callId: 'call-7',
      })),
    );

    await broker.record('run', 'middle', 'caller', {
      text: 'Tests pass',
      kind: 'done',
    });

    expect(written[0]).toMatchObject({
      memberId: 'middle',
      payload: { callId: 'call-7', conversationId: 'conv-1', nodeId: 'middle' },
    });
  });

  it("writes nothing when a step repeats the same conversation's newest one", async () => {
    const { broker, sink, written } = harness();
    broker.register('run', 'senior', sink());
    await broker.record('run', 'senior', 'c', {
      text: 'Build green',
      kind: 'done',
    });

    const again = await broker.record('run', 'senior', 'c', {
      text: 'Build green',
      kind: 'done',
    });
    const otherKind = await broker.record('run', 'senior', 'c', {
      text: 'Build green',
      kind: 'progress',
    });

    expect(again).toEqual({ status: 'unchanged', seq: 1 });
    expect(otherKind).toEqual({ status: 'recorded', seq: 2 });
    expect(written).toHaveLength(2);
  });

  it('refuses past the per-run cap', async () => {
    const { broker, sink, written } = harness();
    broker.register('run', 'senior', sink());
    for (let n = 0; n < MILESTONE_RUN_CAP; n += 1) {
      written.push({
        memberId: 'senior',
        seq: n + 1,
        payload: {
          text: `s${n}`,
          kind: 'progress',
          nodeId: 'senior',
          conversationId: null,
        },
      });
    }

    const outcome = await broker.record('run', 'senior', 'c', {
      text: 'one more',
      kind: 'progress',
    });

    expect(outcome).toMatchObject({ status: 'refused' });
    expect(written).toHaveLength(MILESTONE_RUN_CAP);
  });

  it('answers unavailable, and is not offered, without a sink', async () => {
    const { broker } = harness();

    expect(broker.canUse('run', 'senior')).toBe(false);
    await expect(
      broker.record('run', 'senior', 'c', { text: 'x', kind: 'progress' }),
    ).resolves.toMatchObject({ status: 'unavailable' });
  });
});

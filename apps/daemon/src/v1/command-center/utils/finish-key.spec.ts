import { describe, expect, it } from 'vitest';

import type { RunWire } from '../../agents/chat.types';
import { finishKeyHash, finishKeyOf } from './finish-key';

function runWith(extra: Record<string, unknown> = {}): RunWire {
  return {
    id: 'run-1',
    outcome: null,
    goals: [],
    lastActivityAt: '2026-11-27T10:00:00.000Z',
    attentionAt: '2026-11-27T10:00:00.000Z',
    ...extra,
  } as unknown as RunWire;
}

function outcomeOf(seq: number, summary: string): RunWire['outcome'] {
  return {
    source: 'outcome',
    seq,
    kind: 'done',
    summary,
  } as unknown as RunWire['outcome'];
}

describe('finishKeyHash', () => {
  it('is a sixteen-character hex string', () => {
    expect(
      finishKeyHash(runWith({ outcome: outcomeOf(1, 'Shipped') })),
    ).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is the same when the same finish is read again', () => {
    const run = runWith({ outcome: outcomeOf(1, 'Shipped') });

    expect(finishKeyHash(run)).toBe(finishKeyHash({ ...run }));
  });

  it('changes when the thread finishes again with a new recorded outcome', () => {
    expect(
      finishKeyHash(runWith({ outcome: outcomeOf(2, 'Shipped again') })),
    ).not.toBe(finishKeyHash(runWith({ outcome: outcomeOf(1, 'Shipped') })));
  });

  it('keeps its key for a thread with no recorded outcome when a later row moves its activity', () => {
    expect(
      finishKeyHash(runWith({ lastActivityAt: '2026-11-27T11:00:00.000Z' })),
    ).toBe(finishKeyHash(runWith()));
  });

  it('changes for a thread with no recorded outcome when it finishes again', () => {
    expect(
      finishKeyHash(runWith({ attentionAt: '2026-11-27T11:00:00.000Z' })),
    ).not.toBe(finishKeyHash(runWith()));
  });

  it('hashes the finish key that notifications compare, which keeps its output', () => {
    expect(finishKeyOf(runWith())).toBe(JSON.stringify(['card']));
  });
});

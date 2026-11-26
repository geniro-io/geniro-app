import { describe, expect, it } from 'vitest';

import { announcedIn } from './manager-announced';

describe('announcedIn', () => {
  it('collects threadDone runIds and waitingItems ids', () => {
    const announced = announcedIn([
      { message: 'x', threadDone: [{ runId: 'r1' }, { runId: 'r2' }] },
      { waitingItems: { kind: 'memory', items: [{ id: 'a', title: 'A' }] } },
      { waitingItems: { kind: 'lesson', items: [{ id: 'b' }, { id: 'c' }] } },
    ]);
    expect([...announced.runIds]).toEqual(['r1', 'r2']);
    expect([...announced.itemIds]).toEqual(['a', 'b', 'c']);
  });

  it('skips rows that announce nothing and malformed entries', () => {
    const announced = announcedIn([
      null,
      'text',
      { message: 'plain' },
      { threadDone: 'no', waitingItems: { items: 5 } },
      {
        threadDone: [{ runId: 7 }, null],
        waitingItems: { items: [{ id: 1 }] },
      },
    ]);
    expect(announced.runIds.size).toBe(0);
    expect(announced.itemIds.size).toBe(0);
  });
});

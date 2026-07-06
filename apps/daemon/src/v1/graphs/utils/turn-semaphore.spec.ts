import { describe, expect, it } from 'vitest';

import { createTurnSemaphore } from './turn-semaphore';

describe('createTurnSemaphore', () => {
  it('hands out up to `slots` concurrently and queues the rest in order', async () => {
    const semaphore = createTurnSemaphore(2);
    const r1 = await semaphore.acquire();
    const r2 = await semaphore.acquire();
    let thirdAcquired = false;
    const third = semaphore.acquire().then((release) => {
      thirdAcquired = true;
      return release;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(thirdAcquired).toBe(false);
    r1();
    const r3 = await third;
    expect(thirdAcquired).toBe(true);
    r2();
    r3();
    // All slots free again: two immediate acquires succeed.
    await semaphore.acquire();
    await semaphore.acquire();
  });

  it('a double release never mints an extra slot', async () => {
    const semaphore = createTurnSemaphore(1);
    const release = await semaphore.acquire();
    release();
    release(); // idempotent — must NOT push capacity to 2
    await semaphore.acquire();
    let acquired = false;
    void semaphore.acquire().then(() => {
      acquired = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(acquired).toBe(false);
  });

  it('a release hands the slot straight to the next waiter', async () => {
    const semaphore = createTurnSemaphore(1);
    const r1 = await semaphore.acquire();
    const order: string[] = [];
    const second = semaphore.acquire().then((release) => {
      order.push('second');
      return release;
    });
    const third = semaphore.acquire().then((release) => {
      order.push('third');
      return release;
    });
    r1();
    (await second)();
    await third;
    expect(order).toEqual(['second', 'third']);
  });
});

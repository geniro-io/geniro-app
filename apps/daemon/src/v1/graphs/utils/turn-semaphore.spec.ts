import { describe, expect, it } from 'vitest';

import { createTurnSemaphore, type TurnSlot } from './turn-semaphore';

const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe('createTurnSemaphore', () => {
  it('hands out up to `slots` concurrently and queues the rest in order', async () => {
    const semaphore = createTurnSemaphore(2);
    const s1 = (await semaphore.acquire())!;
    const s2 = (await semaphore.acquire())!;
    let thirdAcquired = false;
    const third = semaphore.acquire().then((slot) => {
      thirdAcquired = true;
      return slot!;
    });
    await tick();
    expect(thirdAcquired).toBe(false);
    expect(semaphore.queued()).toBe(1);
    s1.release();
    const s3 = await third;
    expect(thirdAcquired).toBe(true);
    expect(semaphore.queued()).toBe(0);
    s2.release();
    s3.release();
    expect(semaphore.active()).toBe(0);
  });

  it('a double release never mints an extra slot', async () => {
    const semaphore = createTurnSemaphore(1);
    const slot = (await semaphore.acquire())!;
    slot.release();
    slot.release();
    await semaphore.acquire();
    let acquired = false;
    void semaphore.acquire().then(() => {
      acquired = true;
    });
    await tick();
    expect(acquired).toBe(false);
  });

  it('a release hands the slot straight to the next waiter, in arrival order', async () => {
    const semaphore = createTurnSemaphore(1);
    const s1 = (await semaphore.acquire())!;
    const order: string[] = [];
    const second = semaphore.acquire().then((slot) => {
      order.push('second');
      return slot!;
    });
    const third = semaphore.acquire().then((slot) => {
      order.push('third');
      return slot!;
    });
    s1.release();
    (await second).release();
    await third;
    expect(order).toEqual(['second', 'third']);
  });

  it('an aborted wait leaves the queue and resolves null, never taking a slot', async () => {
    const semaphore = createTurnSemaphore(1);
    const s1 = (await semaphore.acquire())!;
    const controller = new AbortController();
    const cancelled = semaphore.acquire(controller.signal);
    let nextGot: TurnSlot | null = null;
    void semaphore.acquire().then((slot) => {
      nextGot = slot;
    });
    expect(semaphore.queued()).toBe(2);
    controller.abort();
    expect(await cancelled).toBeNull();
    expect(semaphore.queued()).toBe(1);
    s1.release();
    await tick();
    // The slot went to the waiter behind the cancelled one.
    expect(nextGot).not.toBeNull();
    expect(semaphore.active()).toBe(1);
  });

  it('a wait already aborted resolves null at once', async () => {
    const semaphore = createTurnSemaphore(1);
    await semaphore.acquire();
    const controller = new AbortController();
    controller.abort();
    expect(await semaphore.acquire(controller.signal)).toBeNull();
    expect(semaphore.queued()).toBe(0);
  });

  it('a blocked turn gives its slot to a queued fresh turn', async () => {
    const semaphore = createTurnSemaphore(1);
    const caller = (await semaphore.acquire())!;
    let calleeStarted = false;
    void semaphore.acquire().then(() => {
      calleeStarted = true;
    });
    await tick();
    expect(calleeStarted).toBe(false);
    caller.block();
    await tick();
    expect(calleeStarted).toBe(true);
    expect(semaphore.active()).toBe(1);
  });

  it('an unblocked turn is counted again at once, over the cap, never queued', async () => {
    const semaphore = createTurnSemaphore(1);
    const caller = (await semaphore.acquire())!;
    caller.block();
    const callee = (await semaphore.acquire())!;
    caller.unblock();
    expect(semaphore.active()).toBe(2);
    // While over the cap, nothing fresh starts.
    expect(semaphore.tryAcquire()).toBeNull();
    callee.release();
    expect(semaphore.active()).toBe(1);
    expect(semaphore.tryAcquire()).toBeNull();
    caller.release();
    expect(semaphore.active()).toBe(0);
  });

  it('blocks nest: the slot comes back only with the last unblock', async () => {
    const semaphore = createTurnSemaphore(1);
    const turn = (await semaphore.acquire())!;
    turn.block();
    turn.block();
    turn.unblock();
    expect(semaphore.active()).toBe(0);
    turn.unblock();
    expect(semaphore.active()).toBe(1);
    // An unmatched unblock mints nothing.
    turn.unblock();
    expect(semaphore.active()).toBe(1);
  });

  it('a turn released while blocked gives nothing back twice', async () => {
    const semaphore = createTurnSemaphore(1);
    const turn = (await semaphore.acquire())!;
    turn.block();
    turn.release();
    turn.unblock();
    expect(semaphore.active()).toBe(0);
    expect(semaphore.tryAcquire()).not.toBeNull();
    expect(semaphore.tryAcquire()).toBeNull();
  });

  it('admit counts a wake at once even with the cap full and turns queued', async () => {
    const semaphore = createTurnSemaphore(1);
    await semaphore.acquire();
    void semaphore.acquire();
    const wake = semaphore.admit();
    expect(semaphore.active()).toBe(2);
    expect(semaphore.queued()).toBe(1);
    wake.release();
    expect(semaphore.active()).toBe(1);
  });
});

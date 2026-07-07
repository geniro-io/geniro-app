import { describe, expect, it } from 'vitest';

import { KeyedMutex } from './keyed-mutex';

const WAIT = 5_000;

describe('KeyedMutex', () => {
  it('serializes acquires on the same key', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const releaseA = (await mutex.acquire('cwd', WAIT))!;
    const b = mutex.acquire('cwd', WAIT).then((release) => {
      order.push('b-acquired');
      return release!;
    });
    order.push('a-holds');
    // Give b every chance to (wrongly) acquire before a releases.
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['a-holds']);

    releaseA();
    const releaseB = await b;
    expect(order).toEqual(['a-holds', 'b-acquired']);
    releaseB();
  });

  it('keys are independent', async () => {
    const mutex = new KeyedMutex();
    const releaseA = (await mutex.acquire('/one', WAIT))!;
    const releaseB = await mutex.acquire('/two', 50);
    expect(releaseB).not.toBeNull();
    releaseA();
    releaseB!();
  });

  it('a timed-out waiter gets null and does NOT block waiters behind it', async () => {
    const mutex = new KeyedMutex();
    const releaseA = (await mutex.acquire('cwd', WAIT))!;

    const timedOut = await mutex.acquire('cwd', 20);
    expect(timedOut).toBeNull();

    // C queued behind the ghost slot B left; releasing A must reach C.
    const c = mutex.acquire('cwd', WAIT);
    releaseA();
    const releaseC = await c;
    expect(releaseC).not.toBeNull();
    releaseC!();
  });

  it('release is idempotent — a double release cannot free the next holder early', async () => {
    const mutex = new KeyedMutex();
    const releaseA = (await mutex.acquire('cwd', WAIT))!;
    releaseA();
    releaseA(); // second call must be a no-op

    const releaseB = (await mutex.acquire('cwd', WAIT))!;
    let cAcquired = false;
    const c = mutex.acquire('cwd', WAIT).then((release) => {
      cAcquired = true;
      return release!;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(cAcquired).toBe(false); // B still holds despite A's double release

    releaseB();
    (await c)();
    expect(cAcquired).toBe(true);
  });
});

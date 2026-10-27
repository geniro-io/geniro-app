import { describe, expect, it } from 'vitest';

import { KeyedChain } from './keyed-chain';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('KeyedChain', () => {
  it('runs one key’s work in order, each after the previous settles, a failure included', async () => {
    const chain = new KeyedChain();
    const log: string[] = [];
    const gate = deferred();
    const first = chain.run('run-1', async () => {
      await gate.promise;
      log.push('first');
      throw new Error('boom');
    });
    const second = chain.run('run-1', async () => {
      log.push('second');
      return 2;
    });
    await Promise.resolve();
    expect(log).toEqual([]);
    gate.resolve();
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe(2);
    expect(log).toEqual(['first', 'second']);
  });

  it('never makes one key wait on another', async () => {
    const chain = new KeyedChain();
    const gate = deferred();
    const held = chain.run('run-1', () => gate.promise);
    await expect(chain.run('run-2', async () => 'free')).resolves.toBe('free');
    gate.resolve();
    await held;
  });
});

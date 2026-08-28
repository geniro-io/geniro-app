import { describe, expect, it } from 'vitest';

import { RunContextRegistry } from './run-context.registry';

describe('RunContextRegistry', () => {
  it('keeps the WINDOW a later count-only reading says nothing about', () => {
    // claude names the window on its result line and on no assistant line, so
    // every mid-turn reading is a count with no denominator. Replacing rather
    // than merging would leave the ring a numerator with nothing to scale
    // against — the same reason `RunDao.rememberContext` merges.
    const contexts = new RunContextRegistry();

    contexts.remember('r1', { tokens: 10_000, window: 200_000 });
    contexts.remember('r1', { tokens: 42_000, window: null });

    expect(contexts.read('r1')).toEqual({ tokens: 42_000, window: 200_000 });
  });

  it('drops the COUNT on a compaction and keeps the window', () => {
    // The conversation the count measured is gone; the model's window is not,
    // and it is what lets the emptied ring still be drawn as a gauge. Without
    // this the next stamped announce would put the pre-compaction figure back
    // on every client that had just cleared it.
    const contexts = new RunContextRegistry();
    contexts.remember('r1', { tokens: 42_000, window: 200_000 });

    contexts.forgetTokens('r1');

    expect(contexts.read('r1')).toEqual({ tokens: null, window: 200_000 });
  });

  it('holds nothing for a run whose reading was never a reading', () => {
    // Two nulls are not a measurement, and filing them would make an announce
    // claim a run has been measured when nothing has reported.
    const contexts = new RunContextRegistry();

    contexts.remember('r1', { tokens: null, window: null });

    expect(contexts.read('r1')).toBeNull();
  });

  it('forgets a deleted run outright', () => {
    const contexts = new RunContextRegistry();
    contexts.remember('r1', { tokens: 42_000, window: 200_000 });

    contexts.forget('r1');

    expect(contexts.read('r1')).toBeNull();
  });
});

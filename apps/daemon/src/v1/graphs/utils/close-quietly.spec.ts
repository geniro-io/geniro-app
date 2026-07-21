import { describe, expect, it } from 'vitest';

import { closeQuietly } from './close-quietly';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('closeQuietly', () => {
  it('invokes close and swallows its rejection — no unhandled rejection escapes', async () => {
    let closed = false;
    const rejections: unknown[] = [];
    const capture = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', capture);
    try {
      closeQuietly({
        close: () => {
          closed = true;
          return Promise.reject(new Error('transport already gone'));
        },
      });
      await tick();
      await tick();
    } finally {
      process.off('unhandledRejection', capture);
    }

    expect(closed).toBe(true);
    // Deleting the .catch inside closeQuietly makes this rejection escape to
    // the process — this is the assertion that enters the defensive branch.
    expect(rejections).toEqual([]);
  });
});

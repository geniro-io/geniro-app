import { afterEach, describe, expect, it, vi } from 'vitest';

import { terminalIdSchema } from '../main/ipc-schemas';
import { randomId } from './random-id';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('randomId', () => {
  it('mints a UUID main’s own schema accepts', () => {
    expect(terminalIdSchema.safeParse(randomId()).success).toBe(true);
  });

  it('sets the version and variant bits whatever the random bytes are', () => {
    // Deterministic: a schema check on one random sample passes about half
    // the time with either mask removed.
    const fill = (value: number) =>
      vi
        .spyOn(crypto, 'getRandomValues')
        .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
          new Uint8Array(array!.buffer).fill(value);
          return array;
        });
    fill(0xff);
    expect(randomId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    fill(0x00);
    expect(randomId()).toBe('00000000-0000-4000-8000-000000000000');
  });
});

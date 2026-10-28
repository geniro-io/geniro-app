import { describe, expect, it } from 'vitest';

import type { MemoryEntry } from '../../../memory/memory.types';
import {
  memoryForgetResultText,
  readMemoryForgetArgs,
} from './memory-forget.reader';

describe('readMemoryForgetArgs', () => {
  it('needs a handle and a reason', () => {
    expect(readMemoryForgetArgs({ id: 'm3', reason: 'moved to v2' })).toEqual({
      ok: true,
      query: { id: 'm3', reason: 'moved to v2' },
    });
    expect(readMemoryForgetArgs({ id: 'm3' }).ok).toBe(false);
  });
});

describe('memoryForgetResultText', () => {
  it('says the entry is gone for agents but kept', () => {
    expect(
      memoryForgetResultText({
        kind: 'forgotten',
        entry: { handle: 'm3' } as MemoryEntry,
      }),
    ).toEqual({
      text: 'Forgot m3. No agent sees it any more; it is kept, so the user can bring it back.',
      isError: false,
    });
    expect(
      memoryForgetResultText({
        kind: 'refused',
        code: 'NOT_FOUND',
        reason: 'gone',
      }),
    ).toEqual({ text: 'NOT_FOUND: gone', isError: true });
  });
});

import { describe, expect, it } from 'vitest';

import { randomFenceTag } from './fence-tag';

describe('randomFenceTag', () => {
  it('is the prefix and 12 hex characters, fresh on every call', () => {
    const first = randomFenceTag('note');
    expect(first).toMatch(/^note-[0-9a-f]{12}$/);
    expect(randomFenceTag('note')).not.toBe(first);
  });
});

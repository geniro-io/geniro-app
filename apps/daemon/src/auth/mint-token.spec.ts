import { describe, expect, it } from 'vitest';

import { mintToken } from './mint-token';

describe('mintToken', () => {
  it('mints unique 64-char hex tokens', () => {
    const a = mintToken();
    const b = mintToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

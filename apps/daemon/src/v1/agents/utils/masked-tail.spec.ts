import { afterEach, describe, expect, it } from 'vitest';

import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import { maskedTail, SECRET_MARGIN } from './masked-tail';

const SECRET = 'sk-test-0123456789abcdef';

describe('maskedTail', () => {
  afterEach(() => clearSecrets());

  it('gives a short output back whole', () => {
    expect(maskedTail('all done\n', 100)).toBe('all done\n');
  });

  it('masks a registered secret inside the tail', () => {
    registerSecret(SECRET, 'test token');

    const tail = maskedTail(`token ${SECRET} printed`, 100);

    expect(tail).not.toContain(SECRET);
    expect(tail).toContain('printed');
  });

  it('masks a secret the cut at the tail would split, so no part of it shows', () => {
    registerSecret(SECRET, 'test token');
    const max = 20;
    const output = `${'a'.repeat(SECRET_MARGIN)}${SECRET}${'b'.repeat(max - 5)}`;

    const tail = maskedTail(output, max);

    expect(tail).not.toContain(SECRET.slice(-5));
    expect(tail.endsWith('b'.repeat(max - 5))).toBe(true);
  });

  it('never lets the start of the margin into the tail of a long output', () => {
    const max = 10;
    const output = `${'m'.repeat(SECRET_MARGIN)}${'t'.repeat(max)}`;

    expect(maskedTail(output, max)).toBe('t'.repeat(max));
  });
});

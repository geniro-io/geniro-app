import { describe, expect, it } from 'vitest';

import { flattenRole } from './role-text';

describe('flattenRole', () => {
  it('returns empty for absent/empty roles', () => {
    expect(flattenRole(undefined, 100)).toBe('');
    expect(flattenRole(null, 100)).toBe('');
    expect(flattenRole('   ', 100)).toBe('');
  });

  it('collapses interior whitespace and trims', () => {
    expect(flattenRole('  You   review\n\tcode.  ', 100)).toBe(
      'You review code.',
    );
  });

  it('truncates with an ellipsis past the cap, leaves shorter text intact', () => {
    expect(flattenRole('abcdefghij', 5)).toBe('abcde…');
    expect(flattenRole('abcde', 5)).toBe('abcde');
  });
});

import { describe, expect, it } from 'vitest';

import { compareVersions, isNewerVersion, parseVersion } from './version';

describe('isNewerVersion', () => {
  it('compares numerically, not lexically (1.10.0 > 1.9.0)', () => {
    expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true);
    expect(isNewerVersion('1.9.0', '1.10.0')).toBe(false);
  });

  it('never offers a downgrade or a re-install of the running version', () => {
    expect(isNewerVersion('0.9.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
  });

  it('refuses to update when either version is unparseable', () => {
    expect(isNewerVersion('not-a-version', '1.0.0')).toBe(false);
    expect(isNewerVersion('2.0.0', 'nightly')).toBe(false);
  });

  it('tolerates the tag feed’s leading v', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(isNewerVersion('v1.2.3', '1.2.2')).toBe(true);
  });
});

describe('compareVersions', () => {
  it('sorts versions newest last by each numeric component', () => {
    const sorted = ['1.10.0', '1.9.3', '2.0.0', '1.9.10', '1.0.0'].sort(
      compareVersions,
    );
    expect(sorted).toEqual(['1.0.0', '1.9.3', '1.9.10', '1.10.0', '2.0.0']);
  });

  it('reads an unparseable side as equal rather than ordering it', () => {
    expect(compareVersions('nightly', '1.0.0')).toBe(0);
  });
});

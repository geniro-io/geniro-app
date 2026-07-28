import { describe, expect, it } from 'vitest';

import { branchNameSchema, gitDirSchema } from './ipc-schemas';

const accepts = (branch: string): boolean =>
  branchNameSchema.safeParse(branch).success;

describe('branchNameSchema', () => {
  it('accepts the branch names people actually use', () => {
    // Dashes and slashes are the norm — a guard that rejected them would make
    // the picker useless on any real repo.
    for (const branch of [
      'main',
      'feat/some-branch',
      'release-2.0',
      'user/fix_thing',
      'v1.2.3',
    ]) {
      expect(accepts(branch), branch).toBe(true);
    }
  });

  it('rejects a leading dash — the argument-injection case', () => {
    // `git switch` gets this as an argv entry, so there is no shell to inject
    // into; the real hazard is a name git would parse as a FLAG.
    expect(accepts('-f')).toBe(false);
    expect(accepts('--force')).toBe(false);
  });

  it('rejects what git itself forbids in a refname', () => {
    for (const branch of [
      'has space',
      'tilde~1',
      'caret^1',
      'colon:name',
      'question?',
      'star*',
      'bracket[0]',
      'back\\slash',
      'dot..dot',
      'ref@{0}',
      '',
    ]) {
      expect(accepts(branch), branch).toBe(false);
    }
  });

  it('rejects a control character', () => {
    // Written as escapes on purpose: a literal NUL or DEL in the source is
    // invisible, so a later edit could silently delete the case.
    expect(accepts('main\u0000rm -rf')).toBe(false);
    expect(accepts('main\u001f')).toBe(false);
    expect(accepts('main\u007f')).toBe(false);
    expect(accepts('main\ttab')).toBe(false);
  });

  it('rejects an absurdly long name', () => {
    expect(accepts('a'.repeat(256))).toBe(false);
  });
});

describe('gitDirSchema', () => {
  it('requires an absolute path', () => {
    expect(gitDirSchema.safeParse('/Users/me/proj').success).toBe(true);
    expect(gitDirSchema.safeParse('relative/proj').success).toBe(false);
    expect(gitDirSchema.safeParse('').success).toBe(false);
  });
});

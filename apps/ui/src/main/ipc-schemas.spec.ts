import { describe, expect, it } from 'vitest';

import {
  branchNameSchema,
  commitShaSchema,
  gitDirSchema,
  taskIdSchema,
  taskWorktreeSchema,
} from './ipc-schemas';

describe('commitShaSchema', () => {
  const accepted = (value: string): boolean =>
    commitShaSchema.safeParse(value).success;

  it('accepts a commit id as `rev-parse` prints one', () => {
    expect(accepted('a'.repeat(40))).toBe(true);
    expect(accepted('0123456789abcdef0123456789abcdef01234567')).toBe(true);
  });

  it('refuses a revision EXPRESSION, which is a small language', () => {
    // The value becomes argv to `git`. `HEAD~3`, `@{upstream}` and `:/text` are
    // all things git would happily resolve to a commit nobody named here — the
    // only thing this channel has business resolving is an id the app stamped
    // itself. Restated in this process rather than trusted from the daemon's
    // own copy, which is what the schema's doc block says it is for.
    expect(accepted('HEAD')).toBe(false);
    expect(accepted('HEAD~3')).toBe(false);
    expect(accepted('@{upstream}')).toBe(false);
    expect(accepted(':/fix the parser')).toBe(false);
  });

  it('refuses an abbreviation, and anything the wrong length or case', () => {
    expect(accepted('a'.repeat(7))).toBe(false);
    expect(accepted('a'.repeat(39))).toBe(false);
    expect(accepted('a'.repeat(41))).toBe(false);
    expect(accepted('A'.repeat(40))).toBe(false);
  });
});

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

describe('taskIdSchema', () => {
  const accepts = (value: string): boolean =>
    taskIdSchema.safeParse(value).success;

  it('accepts the ids the daemon actually mints', () => {
    expect(accepts('0b3f5a2e-7c11-4d9a-8e2f-1a2b3c4d5e6f')).toBe(true);
    expect(accepts('t1')).toBe(true);
  });

  it('refuses anything that would escape the worktrees directory', () => {
    // The value becomes a path segment under the userData dir AND a git ref.
    // A separator or a dot-dot in it is a write outside the directory this
    // app owns, reached through a channel that only ever meant to name a card.
    for (const bad of ['..', '../etc', 'a/b', 'a\\b', '.hidden', '']) {
      expect(accepts(bad), bad).toBe(false);
    }
  });

  it('refuses characters git would refuse in a ref, and control bytes', () => {
    for (const bad of ['a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[1]']) {
      expect(accepts(bad), bad).toBe(false);
    }
    // Written as escapes: a literal NUL in the source is invisible to review.
    expect(accepts('t\u0000rm')).toBe(false);
    expect(accepts('t\u007f')).toBe(false);
  });

  it('refuses an absurdly long id', () => {
    expect(accepts('a'.repeat(65))).toBe(false);
  });
});

describe('taskWorktreeSchema', () => {
  it('requires a real task id and an absolute folder', () => {
    expect(
      taskWorktreeSchema.safeParse({ taskId: 't1', folder: '/Users/me/proj' })
        .success,
    ).toBe(true);
    expect(
      taskWorktreeSchema.safeParse({ taskId: '../x', folder: '/Users/me/proj' })
        .success,
    ).toBe(false);
    expect(
      taskWorktreeSchema.safeParse({ taskId: 't1', folder: 'relative' })
        .success,
    ).toBe(false);
  });
});

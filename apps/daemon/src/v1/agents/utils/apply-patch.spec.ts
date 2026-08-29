import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { applyHostPatch } from './apply-patch';

/**
 * Real directories, never a mocked filesystem. What most of this file pins is
 * that a write STAYS INSIDE the folder the user pointed the chat at, and a
 * mocked `fs` would pin the mock's idea of `..` and of symlinks rather than the
 * platform's — which is the only one that matters when the write is real.
 */
const made: string[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'patch-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  made.length = 0;
});

describe('applyHostPatch — the ordinary path', () => {
  it('replaces a single match and reports the relative path', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'a.ts'), 'const timeout = 30;\n', 'utf8');

    const outcome = await applyHostPatch(cwd, {
      filePath: 'a.ts',
      oldString: 'const timeout = 30;',
      newString: 'const timeout = 60;',
    });

    expect(outcome).toEqual({ status: 'applied', path: 'a.ts' });
    expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toBe(
      'const timeout = 60;\n',
    );
  });

  it('writes the whole file when no old_string was given', async () => {
    const cwd = await workspace();

    const outcome = await applyHostPatch(cwd, {
      filePath: 'src/deep/new.ts',
      newString: 'export const x = 1;\n',
    });

    expect(outcome).toEqual({ status: 'applied', path: 'src/deep/new.ts' });
    expect(await readFile(join(cwd, 'src/deep/new.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
  });

  it('DELETES the matched text when new_string is empty', async () => {
    // The empty string is a legitimate patch, which is why the reader tests
    // `typeof` rather than truthiness — this is the behaviour that depends on it.
    const cwd = await workspace();
    await writeFile(join(cwd, 'a.ts'), 'keep\nDROP ME\nkeep\n', 'utf8');

    const outcome = await applyHostPatch(cwd, {
      filePath: 'a.ts',
      oldString: 'DROP ME\n',
      newString: '',
    });

    expect(outcome.status).toBe('applied');
    expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toBe('keep\nkeep\n');
  });

  it('accepts an ABSOLUTE path that is inside the folder', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'a.ts'), 'one', 'utf8');

    const outcome = await applyHostPatch(cwd, {
      filePath: resolve(cwd, 'a.ts'),
      oldString: 'one',
      newString: 'two',
    });

    expect(outcome).toEqual({ status: 'applied', path: 'a.ts' });
  });
});

describe('applyHostPatch — containment', () => {
  it('refuses to climb out with ..', async () => {
    const cwd = await workspace();
    const outside = join(cwd, '..', 'escaped.ts');
    await writeFile(outside, 'original', 'utf8');

    const outcome = await applyHostPatch(cwd, {
      filePath: '../escaped.ts',
      oldString: 'original',
      newString: 'owned',
    });

    expect(outcome.status).toBe('stale');
    expect(await readFile(outside, 'utf8')).toBe('original');
  });

  it('refuses an absolute path outside the folder', async () => {
    const cwd = await workspace();
    const other = await workspace();
    await writeFile(join(other, 'b.ts'), 'original', 'utf8');

    const outcome = await applyHostPatch(cwd, {
      filePath: join(other, 'b.ts'),
      oldString: 'original',
      newString: 'owned',
    });

    expect(outcome.status).toBe('stale');
    expect(await readFile(join(other, 'b.ts'), 'utf8')).toBe('original');
  });

  it('refuses a path that leaves through a SYMLINK inside the folder', async () => {
    // The case the lexical check alone cannot see: every component of
    // `link/b.ts` is inside the folder as a string, and the write still lands
    // in another directory entirely. This is why the real path is checked too.
    const cwd = await workspace();
    const other = await workspace();
    await writeFile(join(other, 'b.ts'), 'original', 'utf8');
    await symlink(other, join(cwd, 'link'), 'dir');

    const outcome = await applyHostPatch(cwd, {
      filePath: 'link/b.ts',
      oldString: 'original',
      newString: 'owned',
    });

    expect(outcome.status).toBe('stale');
    expect(await readFile(join(other, 'b.ts'), 'utf8')).toBe('original');
  });

  it('refuses to CREATE a file out through a symlink, not only to edit one', async () => {
    const cwd = await workspace();
    const other = await workspace();
    await symlink(other, join(cwd, 'link'), 'dir');

    const outcome = await applyHostPatch(cwd, {
      filePath: 'link/planted.ts',
      newString: 'export const owned = true;\n',
    });

    expect(outcome.status).toBe('stale');
    await expect(readFile(join(other, 'planted.ts'), 'utf8')).rejects.toThrow();
  });
});

describe('applyHostPatch — the patch no longer fits', () => {
  it('is stale when the text is gone', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'a.ts'), 'somebody else edited this\n', 'utf8');

    const outcome = await applyHostPatch(cwd, {
      filePath: 'a.ts',
      oldString: 'const timeout = 30;',
      newString: 'const timeout = 60;',
    });

    expect(outcome.status).toBe('stale');
    expect(outcome).toHaveProperty(
      'reason',
      expect.stringContaining('no longer'),
    );
  });

  it('is stale when the text appears TWICE — never a coin flip on which', async () => {
    // Picking the first would edit a place the user may not be the one they
    // read in the diff.
    const cwd = await workspace();
    await writeFile(join(cwd, 'a.ts'), 'x = 1;\ny = 2;\nx = 1;\n', 'utf8');

    const outcome = await applyHostPatch(cwd, {
      filePath: 'a.ts',
      oldString: 'x = 1;',
      newString: 'x = 9;',
    });

    expect(outcome.status).toBe('stale');
    expect(outcome).toHaveProperty(
      'reason',
      expect.stringContaining('more than once'),
    );
    // Nothing written at all, rather than one of the two changed.
    expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toBe(
      'x = 1;\ny = 2;\nx = 1;\n',
    );
  });

  it('is stale when an edit names a file that does not exist', async () => {
    const cwd = await workspace();

    const outcome = await applyHostPatch(cwd, {
      filePath: 'missing.ts',
      oldString: 'anything',
      newString: 'else',
    });

    expect(outcome).toEqual({
      status: 'stale',
      reason: 'the file does not exist',
    });
  });

  it('never puts an absolute path into the reason handed to a model', async () => {
    // A filesystem error message carries the full path; the string this returns
    // goes to a provider off this machine, so only the `code` may travel.
    const cwd = await workspace();

    const outcome = await applyHostPatch(cwd, {
      filePath: 'nope/../../../etc/hosts',
      oldString: 'a',
      newString: 'b',
    });

    expect(outcome.status).toBe('stale');
    expect(JSON.stringify(outcome)).not.toContain(cwd);
    expect(JSON.stringify(outcome)).not.toContain('/etc');
  });
});

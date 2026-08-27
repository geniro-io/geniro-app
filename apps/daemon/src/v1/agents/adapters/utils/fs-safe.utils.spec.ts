import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readDirSafe, readFileSafe } from './fs-safe.utils';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function realDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'geniro-fs-safe-'));
  dirs.push(dir);
  return dir;
}

describe('readFileSafe', () => {
  it('answers the contents of a file that is there', async () => {
    const dir = realDir();
    writeFileSync(join(dir, 'there.json'), '{"a":1}');
    expect(await readFileSafe(join(dir, 'there.json'))).toBe('{"a":1}');
  });

  it('answers null rather than throwing on an absent file', async () => {
    expect(await readFileSafe(join(realDir(), 'nope.json'))).toBeNull();
  });

  it('answers null for a path that is a DIRECTORY, not a file', async () => {
    // The case the name is about: every caller builds a path it has not
    // stat'ed, so the wrong KIND of thing at that path has to read as absent
    // rather than throw out of a listing the panel is waiting on.
    expect(await readFileSafe(realDir())).toBeNull();
  });
});

describe('readDirSafe', () => {
  it('answers the entries of a directory that is there', async () => {
    const dir = realDir();
    writeFileSync(join(dir, 'one.md'), '');
    expect((await readDirSafe(dir)).map((entry) => entry.name)).toEqual([
      'one.md',
    ]);
  });

  it('answers none for a directory that is not there', async () => {
    expect(await readDirSafe(join(realDir(), 'missing'))).toEqual([]);
  });
});

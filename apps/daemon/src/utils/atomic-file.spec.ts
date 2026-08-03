import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { atomicCreate, atomicWrite } from './atomic-file';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-file-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Everything in `dir` that is a staging file rather than a committed one. */
async function strayTmpFiles(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
}

describe('atomicWrite', () => {
  it('lands the content at the destination', async () => {
    const path = join(dir, 'store.json');
    await atomicWrite(path, '{"a":1}');

    expect(await readFile(path, 'utf8')).toBe('{"a":1}');
  });

  it('replaces an existing file', async () => {
    const path = join(dir, 'store.json');
    await writeFile(path, 'old', 'utf8');
    await atomicWrite(path, 'new');

    expect(await readFile(path, 'utf8')).toBe('new');
  });

  it('leaves no staging file behind on success', async () => {
    // The tmp file is a private staging name; a stray one would be picked up
    // by any consumer that globs the directory (the workflow library does).
    await atomicWrite(join(dir, 'store.json'), 'x');

    expect(await strayTmpFiles()).toEqual([]);
  });

  it('cleans up the staging file when the commit fails', async () => {
    // A directory at the destination makes `rename` fail AFTER the stage has
    // been written — the one ordering where a partial tmp could survive. The
    // write sits inside the try precisely so this path still cleans up.
    const path = join(dir, 'occupied');
    await mkdir(path);

    await expect(atomicWrite(path, 'content')).rejects.toThrow();
    expect(await strayTmpFiles()).toEqual([]);
  });

  it('gives concurrent writers distinct staging names', async () => {
    // Two writers sharing one `${path}.tmp` would interleave their bytes and
    // race the rename; the loser's content would silently win. Whichever
    // finishes last must land INTACT, never a mix of the two.
    const path = join(dir, 'store.json');
    const a = 'a'.repeat(5000);
    const b = 'b'.repeat(5000);
    await Promise.all([atomicWrite(path, a), atomicWrite(path, b)]);

    const landed = await readFile(path, 'utf8');
    expect([a, b]).toContain(landed);
    expect(await strayTmpFiles()).toEqual([]);
  });
});

describe('atomicCreate', () => {
  it('creates a file that does not exist', async () => {
    const path = join(dir, 'fresh.yaml');
    await atomicCreate(path, 'name: x');

    expect(await readFile(path, 'utf8')).toBe('name: x');
  });

  it('refuses to overwrite an existing file', async () => {
    // This is the whole reason it exists rather than being another
    // atomicWrite: the caller allocates a slug by racing for the name, so a
    // silent overwrite would clobber someone else's workflow.
    const path = join(dir, 'taken.yaml');
    await writeFile(path, 'original', 'utf8');

    await expect(atomicCreate(path, 'intruder')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(path, 'utf8')).toBe('original');
  });

  it('leaves no staging file behind when it refuses', async () => {
    const path = join(dir, 'taken.yaml');
    await writeFile(path, 'original', 'utf8');

    await atomicCreate(path, 'intruder').catch(() => undefined);

    expect(await strayTmpFiles()).toEqual([]);
  });

  it('lets exactly one of two racing creators win the same name', async () => {
    const path = join(dir, 'contended.yaml');
    const results = await Promise.allSettled([
      atomicCreate(path, 'first'),
      atomicCreate(path, 'second'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(['first', 'second']).toContain(await readFile(path, 'utf8'));
  });
});

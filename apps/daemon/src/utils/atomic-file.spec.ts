import { readFileSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('atomicWrite — a file somebody else owns (`preserveTarget`)', () => {
  const OWNER = { preserveTarget: { fallbackMode: 0o600 } };

  it('keeps a private file private', async () => {
    // The reported defect: claude keeps `~/.claude.json` at 0600 and the MCP
    // toggle handed it back 0644 — world-readable, holding the user's account
    // record and every project's history — because a fresh staging file takes
    // the umask, and the rename then REPLACES the old inode's mode with it.
    const path = join(dir, '.claude.json');
    await writeFile(path, '{}', { mode: 0o600 });
    await chmod(path, 0o600);

    await atomicWrite(path, '{"a":1}', OWNER);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toBe('{"a":1}');
  });

  it('keeps whatever mode the owner chose, not merely 0600', async () => {
    const path = join(dir, 'shared.json');
    await writeFile(path, '{}');
    await chmod(path, 0o640);

    await atomicWrite(path, 'x', OWNER);

    expect((await stat(path)).mode & 0o777).toBe(0o640);
  });

  it('creates a missing file at the fallback mode, not the umask', async () => {
    const path = join(dir, 'fresh.json');

    await atomicWrite(path, 'x', OWNER);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('writes THROUGH a symlink and leaves the link in place', async () => {
    // A dotfiles-managed `~/.claude.json` is a symlink into a repo. Renaming
    // over the LINK replaced it with a regular file, silently detaching the
    // user's config from wherever they keep it.
    const real = join(dir, 'real.json');
    const link = join(dir, 'link.json');
    await writeFile(real, 'old');
    await chmod(real, 0o600);
    await symlink(real, link);

    await atomicWrite(link, 'new', OWNER);

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, 'utf8')).toBe('new');
    expect((await stat(real)).mode & 0o777).toBe(0o600);
    expect(await strayTmpFiles()).toEqual([]);
  });

  it('follows a DANGLING symlink rather than replacing it', async () => {
    const link = join(dir, 'link.json');
    await symlink('target.json', link);

    await atomicWrite(link, 'x', OWNER);

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(dir, 'target.json'), 'utf8')).toBe('x');
  });

  it('syncs the staged bytes BEFORE the destination is replaced', async () => {
    // Recorded from inside `sync` itself: what the destination held at that
    // instant is the ordering. A sync after the rename would find the new
    // content already there, and no sync at all records nothing.
    const path = join(dir, 'store.json');
    await writeFile(path, 'old');
    const probe = await open(path, 'r');
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const seenAtSync: string[] = [];
    const real = proto.sync;
    const spy = vi.spyOn(proto, 'sync').mockImplementation(function (
      this: unknown,
    ) {
      seenAtSync.push(readFileSync(path, 'utf8'));
      return real.call(this);
    });
    try {
      await atomicWrite(path, 'new', { fsync: true });
    } finally {
      spy.mockRestore();
    }

    expect(seenAtSync).toEqual(['old']);
    expect(await readFile(path, 'utf8')).toBe('new');
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

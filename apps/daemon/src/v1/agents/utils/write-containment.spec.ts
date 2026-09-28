import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeContainment } from './write-containment';

/**
 * Real directories and real links: every shape here is one the OS resolves
 * differently from a string, which is the whole subject, and a mocked fs would
 * pin the mock's idea of a link rather than the kernel's.
 */
let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'containment-root-'));
  outside = mkdtempSync(join(tmpdir(), 'containment-outside-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(outside, 'secret.txt'), 'x');
  mkdirSync(join(outside, 'deeper', 'sub'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('writeContainment', () => {
  it('reads an ordinary file, and a new one in a new directory, as inside', () => {
    expect(writeContainment(root, join(root, 'src', 'a.ts'))).toBe('inside');
    expect(writeContainment(root, 'src/new/deep/b.ts')).toBe('inside');
  });

  it('reads a plain `..` escape as outside', () => {
    expect(writeContainment(root, '../elsewhere.txt')).toBe('outside');
    expect(writeContainment(root, join(outside, 'secret.txt'))).toBe('outside');
  });

  it('catches a directory in the chain that is a link out', () => {
    symlinkSync(outside, join(root, 'docs'));
    expect(writeContainment(root, 'docs/authorized_keys')).toBe('through-link');
  });

  it('catches a FILE that is itself a link out', () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'notes.md'));
    expect(writeContainment(root, 'notes.md')).toBe('through-link');
  });

  it('catches a dangling link, which a write would create outside', () => {
    symlinkSync(join(outside, 'not-yet.txt'), join(root, 'pending.md'));
    expect(writeContainment(root, 'pending.md')).toBe('through-link');
  });

  it('catches `link/..` in every spelling the kernel reads the same way', () => {
    // `resolve` collapses each of these to `<root>/x.txt`; the kernel goes
    // through the link first and lands beside `deeper`, outside the folder.
    symlinkSync(join(outside, 'deeper'), join(root, 'dirlink'));
    for (const spelling of [
      'dirlink/../x.txt',
      'dirlink/./../x.txt',
      'dirlink//../x.txt',
      'dirlink/sub/../../x.txt',
      'dirlink/not-yet/../../x.txt',
    ]) {
      expect(writeContainment(root, spelling), spelling).toBe('through-link');
    }
  });

  it('catches `link/..` given as an ABSOLUTE path, the form codex sends', () => {
    // Built as a string: `join` would collapse the `..` before the check saw it.
    symlinkSync(join(outside, 'deeper'), join(root, 'dirlink'));
    expect(writeContainment(root, `${root}/dirlink/../x.txt`)).toBe(
      'through-link',
    );
  });

  it('reads the RESOLVED path a writer hands the kernel where it lands', () => {
    // What `applyHostPatch` passes: `..` is already gone, so the only reading
    // left is the one the write takes.
    symlinkSync(join(outside, 'deeper'), join(root, 'dirlink'));
    expect(writeContainment(root, resolve(root, 'dirlink/../x.txt'))).toBe(
      'inside',
    );
  });

  it('catches a path that escapes only once `..` is collapsed first', () => {
    // Read as written, `a/..` steps back inside the link's target and lands at
    // `inner/escape/x.txt`; a writer that resolves first — codex's own does —
    // lands in `escape`, a link out. Only the resolved reading sees it.
    mkdirSync(join(root, 'inner', 'deep'), { recursive: true });
    symlinkSync(join(root, 'inner', 'deep'), join(root, 'a'));
    symlinkSync(outside, join(root, 'escape'));
    expect(writeContainment(root, 'a/../escape/x.txt')).toBe('through-link');
  });

  it('allows a `..` that steps back out of an ordinary directory', () => {
    expect(writeContainment(root, 'src/../a.txt')).toBe('inside');
  });

  it('allows a link that stays inside the folder', () => {
    writeFileSync(join(root, 'src', 'real.md'), 'x');
    symlinkSync(join(root, 'src', 'real.md'), join(root, 'README.md'));
    expect(writeContainment(root, 'README.md')).toBe('inside');
  });

  it('does not mistake a folder reached through a link for an escape', () => {
    // A macOS temp dir sits under `/var`, itself a link, but a CI runner's does
    // not — so the root is made a link here rather than left to the platform.
    const linked = join(outside, 'linked-root');
    symlinkSync(root, linked);
    expect(writeContainment(linked, 'src/new/b.ts')).toBe('inside');
    expect(writeContainment(linked, `${linked}/src/a.ts`)).toBe('inside');
    symlinkSync(join(outside, 'deeper'), join(root, 'dirlink'));
    expect(writeContainment(linked, 'dirlink/x.txt')).toBe('through-link');
  });
});

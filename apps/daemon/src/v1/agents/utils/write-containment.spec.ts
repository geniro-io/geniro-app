import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hasOtherHardLinks, writeContainment } from './write-containment';

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

describe('hasOtherHardLinks', () => {
  it('is false for an ordinary file, a path naming nothing and a directory', () => {
    writeFileSync(join(root, 'plain.txt'), 'x');
    expect(hasOtherHardLinks(root, 'plain.txt')).toBe(false);
    expect(hasOtherHardLinks(root, 'nothing.txt')).toBe(false);
    expect(hasOtherHardLinks(root, 'src')).toBe(false);
    // Beneath a file, which is no directory: still nothing there to share.
    expect(hasOtherHardLinks(root, 'plain.txt/inside')).toBe(false);
  });

  it('is true for a file another name shares, even one outside the folder', () => {
    linkSync(join(outside, 'secret.txt'), join(root, 'shared.txt'));
    expect(hasOtherHardLinks(root, join(root, 'shared.txt'))).toBe(true);
  });

  it('follows a link at the name, since the file it lands on is the one written', () => {
    linkSync(join(outside, 'secret.txt'), join(root, 'shared.txt'));
    symlinkSync(join(root, 'shared.txt'), join(root, 'alias'));
    expect(hasOtherHardLinks(root, join(root, 'alias'))).toBe(true);
  });

  // `link` leads into `a/b`, so a `..` after it names `a` as written and the
  // folder itself once collapsed. Each spelling is one a writer may be handed,
  // codex's own being the absolute one.
  const spellings: [string, (folder: string) => string][] = [
    ['relative', () => 'link/../x'],
    ['absolute', (folder) => `${folder}/link/../x`],
  ];

  it.each(spellings)(
    'reports a file shared through `link/..` read as written, where it steps out of the link’s target — %s',
    (_name, spelled) => {
      mkdirSync(join(root, 'a', 'b'), { recursive: true });
      symlinkSync(join(root, 'a', 'b'), join(root, 'link'));
      linkSync(join(outside, 'secret.txt'), join(root, 'a', 'x'));
      expect(hasOtherHardLinks(root, spelled(root))).toBe(true);
    },
  );

  it.each(spellings)(
    'reports a file shared through `link/..` collapsed first, which is what a resolving writer does — %s',
    (_name, spelled) => {
      mkdirSync(join(root, 'a', 'b'), { recursive: true });
      symlinkSync(join(root, 'a', 'b'), join(root, 'link'));
      writeFileSync(join(root, 'a', 'x'), 'plain');
      linkSync(join(outside, 'secret.txt'), join(root, 'x'));
      expect(hasOtherHardLinks(root, spelled(root))).toBe(true);
    },
  );

  it('walks a directory that does not exist yet as a writer that creates it would, not as a stat of the string', () => {
    // `newdir` is not there, so a stat of the raw path stops at it and finds
    // nothing; a writer that creates it and reads the `..` as written reaches
    // `a/x`, which `writeContainment` also walked.
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    symlinkSync(join(root, 'a', 'b'), join(root, 'link'));
    linkSync(join(outside, 'secret.txt'), join(root, 'a', 'x'));
    expect(hasOtherHardLinks(root, 'link/../newdir/../x')).toBe(true);
    expect(writeContainment(root, 'link/../newdir/../x')).toBe('inside');
  });

  it('answers a link that leads nowhere as one that shares', () => {
    symlinkSync(join(outside, 'not-there'), join(root, 'dangling'));
    expect(hasOtherHardLinks(root, 'dangling')).toBe(true);
  });

  it('answers a path it cannot examine as one that shares', () => {
    // A name past the filesystem's limit fails to stat whoever asks, which is
    // not the same as naming nothing.
    expect(hasOtherHardLinks(root, 'x'.repeat(300))).toBe(true);
  });
});

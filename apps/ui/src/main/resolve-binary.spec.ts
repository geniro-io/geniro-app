import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

/**
 * `WELL_KNOWN_DIRS` is built from `homedir()` at MODULE LOAD, so the home is
 * stubbed before the import below. That is what makes the well-known-dirs arm —
 * the module's entire reason for existing — testable at all: it is the arm that
 * matters only in a packaged build, where `$PATH` is launchd's four entries, and
 * the alternative to stubbing is writing a binary into the developer's real
 * `~/.local/bin`.
 */
/**
 * `mkdtemp`, never a name built from the pid: a predictable path in a
 * world-writable `/tmp` can be pre-created as a symlink by another local user,
 * and this file then writes 0755 files through it and recursively deletes
 * through it in `afterEach`. `node:os` is deliberately NOT imported for the
 * temp root — importing it here would run the mock factory below before `home`
 * is assigned.
 */
const TEMP_ROOT = process.env.TMPDIR ?? '/tmp';
const home = mkdtempSync(join(TEMP_ROOT, 'geniro-resolve-binary-home-'));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home };
});

const { resolveBinary } = await import('./resolve-binary');

let pathDir = '';
let originalPath = '';

/** An executable file named `name` in `dir`. */
function putBinary(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return path;
}

beforeEach(() => {
  pathDir = mkdtempSync(join(TEMP_ROOT, 'geniro-path-'));
  originalPath = process.env.PATH ?? '';
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(pathDir, { recursive: true, force: true });
  rmSync(join(home, '.local'), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('resolveBinary', () => {
  it('finds a binary that is NOT on $PATH but is in a well-known install dir', () => {
    // The arm the module exists for. A packaged app launched from Finder runs
    // under launchd's `/usr/bin:/bin:/usr/sbin:/sbin`, so a Homebrew- or
    // npm-installed CLI is reachable ONLY through this list — and a miss here is
    // silent, because a failed spawn is swallowed into "nothing to show".
    const expected = putBinary(join(home, '.local', 'bin'), 'geniro-probe');
    process.env.PATH = pathDir;

    expect(resolveBinary('geniro-probe')).toBe(expected);
  });

  it('prefers $PATH over the well-known dirs', () => {
    // The user's own PATH is the more specific answer, and the extra dirs are a
    // fallback rather than an override.
    const onPath = putBinary(pathDir, 'geniro-probe');
    putBinary(join(home, '.local', 'bin'), 'geniro-probe');
    process.env.PATH = pathDir;

    expect(resolveBinary('geniro-probe')).toBe(onPath);
  });

  it('takes an executable override ahead of any search', () => {
    const override = putBinary(pathDir, 'somewhere-else');

    expect(resolveBinary('geniro-probe', override)).toBe(override);
  });

  it('ignores an override that is not executable and searches anyway', () => {
    const notExecutable = join(pathDir, 'not-executable');
    writeFileSync(notExecutable, 'text', { mode: 0o644 });
    const expected = putBinary(join(home, '.local', 'bin'), 'geniro-probe');
    process.env.PATH = pathDir;

    expect(resolveBinary('geniro-probe', notExecutable)).toBe(expected);
  });

  it('skips empty and relative $PATH entries', () => {
    // A resolved path is handed to `execFile`, so a relative entry would make
    // the answer depend on the process's working directory.
    const expected = putBinary(join(home, '.local', 'bin'), 'geniro-probe');
    process.env.PATH = `::relative/bin:${join(pathDir, 'missing')}`;

    expect(resolveBinary('geniro-probe')).toBe(expected);
  });

  it('answers null when the binary is nowhere', () => {
    process.env.PATH = pathDir;

    expect(resolveBinary('geniro-definitely-absent')).toBeNull();
  });
});

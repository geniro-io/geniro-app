import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DAEMON_VERSION, readDaemonVersion } from './daemon-version';

describe('readDaemonVersion', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'geniro-ver-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the version string from the given package.json', () => {
    // The real pin: the version comes from the FILE, not a literal. A revert to
    // a hardcoded constant would make this fixture value unreachable.
    const p = join(dir, 'package.json');
    writeFileSync(p, JSON.stringify({ version: '9.9.9-test' }));
    expect(readDaemonVersion(p)).toBe('9.9.9-test');
  });

  it('falls back to 0.0.0 when the file is missing', () => {
    // Exercises the defensive catch — a missing package.json must not throw.
    expect(readDaemonVersion(join(dir, 'nope', 'package.json'))).toBe('0.0.0');
  });

  it('falls back to 0.0.0 when package.json has no version field', () => {
    const p = join(dir, 'package.json');
    writeFileSync(p, JSON.stringify({ name: 'geniro-daemon' }));
    expect(readDaemonVersion(p)).toBe('0.0.0');
  });

  it('DAEMON_VERSION is wired to the real daemon package.json', () => {
    // Pins the DEFAULT path argument, which is what production uses and which
    // has to keep resolving from `utils/` after this file moved out of
    // `environments/`.
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(DAEMON_VERSION).toBe(pkg.version);
  });
});

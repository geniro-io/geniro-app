import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userData: '',
  showItemInFolder: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData },
  shell: { showItemInFolder: mocks.showItemInFolder },
}));

const { revealPath } = await import('./reveal-path');

let logDir: string;

beforeEach(() => {
  mocks.showItemInFolder.mockClear();
  mocks.userData = mkdtempSync(join(tmpdir(), 'reveal-spec-'));
  logDir = join(mocks.userData, 'logs');
  mkdirSync(logDir, { recursive: true });
});

/** Create a file and return the path, `realpath`-resolved like the code does. */
function file(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, 'x');
  return path;
}

describe('revealPath', () => {
  it('reveals a file inside the daemon’s log directory', () => {
    const log = file(logDir, 'geniro-daemon-1.jsonl');

    expect(revealPath(log)).toEqual({ revealed: true, reason: null });
    expect(mocks.showItemInFolder).toHaveBeenCalledWith(realpathSync(log));
  });

  it('REFUSES a path outside the log directory', () => {
    // The argument comes from the sandboxed renderer. The daemon is where the
    // path originates, but a compromised renderer is what would be calling
    // this — so the confinement is not a formality.
    const outside = file(mocks.userData, 'settings.json');

    const result = revealPath(outside);

    expect(result.revealed).toBe(false);
    expect(result.reason).toContain('only the daemon');
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  });

  it('REFUSES a traversal out of the log directory', () => {
    file(mocks.userData, 'geniro.db');

    const result = revealPath(join(logDir, '..', 'geniro.db'));

    expect(result.revealed).toBe(false);
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  });

  it('REFUSES a symlink planted inside the log directory', () => {
    // `resolve` alone normalises `..` but follows nothing, so a symlink is the
    // escape that a path-string check misses. This is why the code resolves
    // through `realpath` before comparing.
    const secret = file(mocks.userData, 'secrets.json');
    const link = join(logDir, 'innocent.jsonl');
    symlinkSync(secret, link);

    const result = revealPath(link);

    expect(result.revealed).toBe(false);
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  });

  it('REFUSES a sibling directory whose name merely starts the same', () => {
    // `startsWith(logDir)` without a separator would pass `…/logsofsomething`.
    const sibling = join(mocks.userData, 'logsomething');
    mkdirSync(sibling, { recursive: true });
    const sneaky = file(sibling, 'x.jsonl');

    expect(revealPath(sneaky).revealed).toBe(false);
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  });

  it('answers with a reason, never a throw, for a file that is gone', () => {
    // The button is a convenience and the panel shows the path as text anyway,
    // so a stale path must degrade to an explanation rather than an error.
    const result = revealPath(join(logDir, 'never-existed.jsonl'));

    expect(result.revealed).toBe(false);
    expect(result.reason).toContain('no longer exists');
  });
});

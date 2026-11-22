import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { watchProcessState } from './process-state-guard';

const ADDED = 'GENIRO_GUARD_SPEC_ADDED';
const CHANGED = 'GENIRO_GUARD_SPEC_CHANGED';
const REMOVED = 'GENIRO_GUARD_SPEC_REMOVED';

describe('watchProcessState', () => {
  afterEach(() => {
    delete process.env[ADDED];
    delete process.env[CHANGED];
    delete process.env[REMOVED];
  });

  it('reports nothing when the process is as it found it', () => {
    const leftBehind = watchProcessState();
    process.env[ADDED] = 'transient';
    delete process.env[ADDED];

    expect(leftBehind()).toEqual([]);
  });

  it('leaves alone the env key MikroORM writes each time an ORM is created', () => {
    const before = process.env.MIKRO_ORM_COLORS;
    const leftBehind = watchProcessState();
    process.env.MIKRO_ORM_COLORS = before === 'false' ? 'true' : 'false';
    try {
      expect(leftBehind()).toEqual([]);
    } finally {
      if (before === undefined) {
        delete process.env.MIKRO_ORM_COLORS;
      } else {
        process.env.MIKRO_ORM_COLORS = before;
      }
    }
  });

  it('names every env key added, changed or removed, and puts each back', () => {
    process.env[CHANGED] = 'before';
    process.env[REMOVED] = 'kept';
    const leftBehind = watchProcessState();
    process.env[ADDED] = 'new';
    process.env[CHANGED] = 'after';
    delete process.env[REMOVED];

    const leaks = leftBehind();

    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toContain(ADDED);
    expect(leaks[0]).toContain(CHANGED);
    expect(leaks[0]).toContain(REMOVED);
    expect(process.env[ADDED]).toBeUndefined();
    expect(process.env[CHANGED]).toBe('before');
    expect(process.env[REMOVED]).toBe('kept');
  });

  it('reports a changed working directory and returns to the first one', () => {
    const start = process.cwd();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'guard-cwd-')));
    try {
      const leftBehind = watchProcessState();
      process.chdir(elsewhere);

      expect(leftBehind()).toEqual([`cwd was left at ${elsewhere}`]);
      expect(process.cwd()).toBe(start);
    } finally {
      process.chdir(start);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('reports a built-in module left patched and puts the original back', () => {
    const fs = process.getBuiltinModule('node:fs');
    const realExistsSync = fs.existsSync;
    const leftBehind = watchProcessState();
    vi.spyOn(fs, 'existsSync');

    expect(leftBehind()).toEqual([
      'node:fs was left patched: existsSync (mock a built-in with a factory, never { spy: true })',
    ]);
    expect(fs.existsSync).toBe(realExistsSync);
  });

  it('reports fake timers left on and turns them off', () => {
    const leftBehind = watchProcessState();
    vi.useFakeTimers();

    expect(leftBehind()).toEqual(['fake timers were left on']);
    expect(vi.isFakeTimers()).toBe(false);
  });
});

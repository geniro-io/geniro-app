import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BadRequestException } from '@packages/common';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { resolveValidCwd } from './resolve-cwd';

/**
 * The one directory whose OPEN fails, and how — nothing else is touched, so the
 * real filesystem answers every other call. macOS privacy protection cannot be
 * produced in a test, but its observable is exactly this: `opendir` throwing
 * `EPERM` on a folder that `realpath` and `stat` accept.
 */
const denied = vi.hoisted(() => ({ path: null as string | null, code: '' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    opendirSync: (path: string, ...rest: unknown[]) => {
      if (denied.path !== null && path === denied.path) {
        throw Object.assign(new Error(`${denied.code}: denied, opendir`), {
          code: denied.code,
        });
      }
      return (actual.opendirSync as (...args: unknown[]) => unknown)(
        path,
        ...rest,
      );
    },
  };
});

afterEach(() => {
  denied.path = null;
});

const created: string[] = [];

afterAll(() => {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-cwd-'));
  created.push(dir);
  return dir;
}

describe('resolveValidCwd', () => {
  it('keeps naming cwd after the shared core became parameterised', () => {
    // `resolveValidDirectory` takes its errorCode and noun from the caller, so
    // both are now values this wrapper can get wrong. Nothing else asserts
    // them: `skills.service.spec.ts` matches /INVALID_CWD|does not exist/, and
    // the second alternative holds for ANY noun — so passing the plugin
    // wrapper's arguments here would leave every bad-folder refusal saying
    // "Plugin directory" while the suite stayed green.
    for (const bad of ['relative/path', join(tempDir(), 'missing')]) {
      try {
        resolveValidCwd(bad);
        expect.unreachable('expected a refusal');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const refusal = err as BadRequestException;
        expect(refusal.errorCode).toBe('INVALID_CWD');
        expect(refusal.getMessage()).toContain('cwd');
        expect(refusal.getMessage()).not.toContain('Plugin directory');
      }
    }
  });

  it('refuses a folder macOS will not let it open, naming where to allow it', () => {
    // REPORTED as a Manager failing on every message with claude's own
    // `An unknown error occurred (Unexpected)`: realpath and stat passed on a
    // Desktop folder Geniro had lost access to, and only opening it failed.
    const dir = tempDir();
    denied.path = realpathSync(dir);
    denied.code = 'EPERM';
    try {
      resolveValidCwd(dir);
      expect.unreachable('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const refusal = err as BadRequestException;
      // Not INVALID_CWD: the renderer rebuilds a task's worktree on that code.
      expect(refusal.errorCode).toBe('FOLDER_NOT_READABLE');
      expect(refusal.getMessage()).toContain(dir);
      expect(refusal.getMessage()).toContain('Privacy & Security');
    }
  });

  it('returns the canonical path for a real directory', () => {
    const dir = tempDir();
    expect(resolveValidCwd(dir)).toBe(realpathSync(dir));
  });
});

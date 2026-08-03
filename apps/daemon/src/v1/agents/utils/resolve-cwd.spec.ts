import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BadRequestException } from '@packages/common';
import { afterAll, describe, expect, it } from 'vitest';

import { resolveValidCwd } from './resolve-cwd';

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

  it('returns the canonical path for a real directory', () => {
    const dir = tempDir();
    expect(resolveValidCwd(dir)).toBe(realpathSync(dir));
  });
});

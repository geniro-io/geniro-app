import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BadRequestException } from '@packages/common';
import { afterAll, describe, expect, it } from 'vitest';

import { resolveValidConfigDir } from './resolve-config-dir';

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'config-dir-'));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The refusal a caller sees, or `null` when the call was accepted. */
function refusalOf(configDir: string): BadRequestException | null {
  try {
    resolveValidConfigDir(configDir);
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return err as BadRequestException;
  }
}

describe('resolveValidConfigDir', () => {
  it('accepts an existing directory and returns its canonical path', () => {
    const dir = tempDir();
    expect(resolveValidConfigDir(dir)).toBe(realpathSync(dir));
  });

  it('resolves a symlink to its target', () => {
    const target = tempDir();
    const link = join(tempDir(), 'link');
    symlinkSync(target, link);
    expect(resolveValidConfigDir(link)).toBe(realpathSync(target));
  });

  it('refuses a relative path', () => {
    // The var reaches the CLI as-is and a relative value resolves against the
    // CHILD's cwd — the run's own folder — so the same profile would be a
    // different directory in every project it was used from.
    const refusal = refusalOf('./profiles/work');
    expect(refusal?.errorCode).toBe('INVALID_CONFIG_DIR');
    expect(refusal?.getMessage()).toContain('absolute');
  });

  it('refuses a path that does not exist', () => {
    // The refusal that matters most: claude CREATES whatever directory it is
    // handed and reports "Not logged in" (probe-verified on 2.1.227), so a
    // typo would silently start a brand-new signed-out profile instead of
    // failing.
    const refusal = refusalOf(join(tempDir(), 'no-such-profile'));
    expect(refusal?.errorCode).toBe('INVALID_CONFIG_DIR');
    expect(refusal?.getMessage()).toContain('does not exist');
  });

  it('refuses a file', () => {
    const file = join(tempDir(), 'profile.json');
    writeFileSync(file, 'not a directory');
    const refusal = refusalOf(file);
    expect(refusal?.errorCode).toBe('INVALID_CONFIG_DIR');
    expect(refusal?.getMessage()).toContain('not a directory');
  });

  it('names the FIELD LABEL, not cwd and not the wire key', () => {
    // The shared core is parameterised by noun, and this sentence is rendered
    // under the chip the user just typed into: a caller that forgot to pass
    // its own would tell them their "cwd" was wrong while they were editing a
    // config directory, and the wire key would name an identifier they never
    // see.
    for (const bad of ['relative/path', join(tempDir(), 'missing')]) {
      const message = refusalOf(bad)?.getMessage();
      expect(message).toContain('Config directory');
      expect(message).not.toContain('cwd');
      expect(message).not.toContain('configDir');
    }
  });
});

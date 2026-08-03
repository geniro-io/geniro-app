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

import { resolveValidPluginDir } from './resolve-plugin-dir';

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-dir-'));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The refusal a caller sees, or `null` when the call was accepted. */
function refusalOf(pluginDir: string): BadRequestException | null {
  try {
    resolveValidPluginDir(pluginDir);
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return err as BadRequestException;
  }
}

describe('resolveValidPluginDir', () => {
  it('accepts an existing directory and returns its canonical path', () => {
    const dir = tempDir();
    expect(resolveValidPluginDir(dir)).toBe(realpathSync(dir));
  });

  it('resolves a symlink to its target', () => {
    const target = tempDir();
    const link = join(tempDir(), 'link');
    symlinkSync(target, link);
    expect(resolveValidPluginDir(link)).toBe(realpathSync(target));
  });

  it('refuses a relative path', () => {
    // The CLI resolves a relative --plugin-dir against the process cwd
    // (probe-verified), which for a turn is the RUN's folder and for the
    // builder is nothing meaningful — so the same workflow would load
    // different plugins depending on where it ran.
    const refusal = refusalOf('./plugins/reviewer');
    expect(refusal?.errorCode).toBe('INVALID_PLUGIN_DIR');
    expect(refusal?.getMessage()).toContain('absolute');
  });

  it('refuses a path that does not exist', () => {
    const refusal = refusalOf(join(tempDir(), 'no-such-plugin'));
    expect(refusal?.errorCode).toBe('INVALID_PLUGIN_DIR');
    expect(refusal?.getMessage()).toContain('does not exist');
  });

  it('refuses a file, including the .zip the CLI would have accepted', () => {
    const zip = join(tempDir(), 'plugin.zip');
    writeFileSync(zip, 'not a directory');
    const refusal = refusalOf(zip);
    expect(refusal?.errorCode).toBe('INVALID_PLUGIN_DIR');
    expect(refusal?.getMessage()).toContain('not a directory');
  });

  it('names pluginDir, not cwd, in every refusal', () => {
    // The shared core is parameterised by noun; a caller that forgot to pass
    // its own would silently tell the user their "cwd" was wrong while they
    // were editing a node's plugin directory.
    for (const bad of ['relative/path', join(tempDir(), 'missing')]) {
      expect(refusalOf(bad)?.getMessage()).toContain('pluginDir');
    }
  });
});

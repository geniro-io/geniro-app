import { execFileSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isRealDirectory, readRegularFile } from './regular-file.utils';

describe('regular-file utils', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'geniro-regular-file-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a file at its byte cap and refuses one a byte over it', async () => {
    writeFileSync(join(dir, 'at.md'), 'abcd');
    writeFileSync(join(dir, 'over.md'), 'abcde');

    expect(await readRegularFile(join(dir, 'at.md'), 4)).toBe('abcd');
    expect(await readRegularFile(join(dir, 'over.md'), 4)).toBeNull();
  });

  it('refuses a symlink, a hard-linked file, a directory and a missing path', async () => {
    writeFileSync(join(dir, 'real.md'), 'x');
    symlinkSync(join(dir, 'real.md'), join(dir, 'link.md'));
    writeFileSync(join(dir, 'shared.md'), 'y');
    linkSync(join(dir, 'shared.md'), join(dir, 'hard.md'));
    mkdirSync(join(dir, 'sub'));

    expect(await readRegularFile(join(dir, 'link.md'), 10)).toBeNull();
    expect(await readRegularFile(join(dir, 'hard.md'), 10)).toBeNull();
    expect(await readRegularFile(join(dir, 'sub'), 10)).toBeNull();
    expect(await readRegularFile(join(dir, 'gone.md'), 10)).toBeNull();
  });

  it('answers null at once for a FIFO instead of waiting on a writer', async () => {
    execFileSync('mkfifo', [join(dir, 'pipe.md')]);

    expect(await readRegularFile(join(dir, 'pipe.md'), 10)).toBeNull();
  });

  it('counts only a directory itself, never a symlink to one', async () => {
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));

    expect(await isRealDirectory(join(dir, 'real'))).toBe(true);
    expect(await isRealDirectory(join(dir, 'link'))).toBe(false);
    expect(await isRealDirectory(join(dir, 'gone'))).toBe(false);
  });
});

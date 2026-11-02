import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isExecutableOnPath } from './executable-on-path';

describe('isExecutableOnPath', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'geniro-exec-on-path-'));
    writeFileSync(join(dir, 'tool'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(dir, 'tool'), 0o755);
    writeFileSync(join(dir, 'plain'), 'not a program');
    chmodSync(join(dir, 'plain'), 0o644);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds a bare name in any PATH entry, and only an executable one', () => {
    expect(isExecutableOnPath('tool', `/nowhere:${dir}`)).toBe(true);
    expect(isExecutableOnPath('plain', dir)).toBe(false);
    expect(isExecutableOnPath('absent', dir)).toBe(false);
    expect(isExecutableOnPath('tool', '')).toBe(false);
  });

  it('checks a path as given, whatever PATH holds', () => {
    expect(isExecutableOnPath(join(dir, 'tool'), '')).toBe(true);
    expect(isExecutableOnPath(join(dir, 'absent'), dir)).toBe(false);
    expect(isExecutableOnPath(dir, '')).toBe(false);
  });
});

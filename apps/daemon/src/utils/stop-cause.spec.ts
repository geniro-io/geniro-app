import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DAEMON_STOP_CAUSE_NAME } from './handshake';
import {
  consumeStopCause,
  parseInterruptCause,
  resumesUnattended,
} from './stop-cause';

describe('consumeStopCause', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'geniro-stop-cause-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the cause the UI wrote and removes the note', () => {
    const path = join(dir, DAEMON_STOP_CAUSE_NAME);
    writeFileSync(path, 'self-update\n');

    expect(consumeStopCause(dir)).toBe('self-update');
    expect(existsSync(path)).toBe(false);
  });

  it('trusts no note it cannot remove — it would label the next SIGKILL', () => {
    writeFileSync(join(dir, DAEMON_STOP_CAUSE_NAME), 'restart');
    chmodSync(dir, 0o500);
    try {
      expect(consumeStopCause(dir)).toBe('unknown');
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('reads no note as unknown', () => {
    expect(consumeStopCause(dir)).toBe('unknown');
  });

  it('reads a word it does not know as unknown, and still removes it', () => {
    const path = join(dir, DAEMON_STOP_CAUSE_NAME);
    writeFileSync(path, 'reboot');

    expect(consumeStopCause(dir)).toBe('unknown');
    expect(existsSync(path)).toBe(false);
  });
});

describe('resumesUnattended', () => {
  it('continues only after a stop the app made on purpose', () => {
    expect(resumesUnattended('quit')).toBe(true);
    expect(resumesUnattended('self-update')).toBe(true);
    expect(resumesUnattended('restart')).toBe(true);
    expect(resumesUnattended('crash')).toBe(false);
    expect(resumesUnattended('unknown')).toBe(false);
  });
});

describe('parseInterruptCause', () => {
  it('reads a stored cause, and anything else as unknown', () => {
    expect(parseInterruptCause('crash')).toBe('crash');
    expect(parseInterruptCause(undefined)).toBe('unknown');
    expect(parseInterruptCause(7)).toBe('unknown');
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loginShellPath, parseLoginShellPath } from './login-shell-path';

describe('parseLoginShellPath', () => {
  it('takes the last sentinel-marked line through rc noise', () => {
    const stdout = [
      'Welcome banner from .zshrc',
      '__GENIRO_PATH__/stale:/from/an/rc/echo',
      '__GENIRO_PATH__/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      '',
    ].join('\n');

    expect(parseLoginShellPath(stdout)).toBe(
      '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    );
  });

  it('rejects output without the sentinel', () => {
    expect(parseLoginShellPath('/usr/bin:/bin')).toBeNull();
    expect(parseLoginShellPath('')).toBeNull();
  });

  it('rejects a fish-style space-joined PATH (no colons)', () => {
    // fish expands "$PATH" inside quotes joined by SPACES; replacing the
    // daemon's PATH with that single token would break every binary lookup —
    // strictly worse than keeping launchd's minimal default.
    expect(
      parseLoginShellPath('__GENIRO_PATH__/opt/homebrew/bin /usr/bin /bin'),
    ).toBeNull();
  });

  it('rejects an empty or pathless value', () => {
    expect(parseLoginShellPath('__GENIRO_PATH__')).toBeNull();
    expect(parseLoginShellPath('__GENIRO_PATH__   ')).toBeNull();
  });
});

/**
 * Driven against REAL processes: what is under test is how a child that
 * misbehaves — reads its stdin, ignores SIGTERM, leaves a job holding the pipe
 * — is ended, and a mocked `spawn` would only replay this file's assumptions
 * about signals and pipes. Each "shell" is a small script standing in for the
 * user's rc files; it ignores the `-ilc` it is handed.
 */
describe('loginShellPath', () => {
  let scratch = '';

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'geniro-login-shell-'));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /**
   * A freshly written script, which macOS assesses on its first exec — measured
   * at ~400ms before its first line runs. Every budget below leaves room for
   * that, or a case would be timing the assessment rather than the code.
   */
  const fakeShell = (body: string): string => {
    const path = join(scratch, 'shell.sh');
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return path;
  };

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('resolves the PATH the shell echoes', async () => {
    const shell = fakeShell(
      'echo "rc banner"\necho "__GENIRO_PATH__/opt/homebrew/bin:/usr/bin"',
    );

    await expect(loginShellPath(3000, shell)).resolves.toBe(
      '/opt/homebrew/bin:/usr/bin',
    );
  });

  it('answers at once when an rc file READS its stdin, rather than waiting on it', async () => {
    // Its stdin used to be an open pipe nobody wrote to, so a `read` in an rc
    // file blocked until the deadline — and past it, since the shell ignored
    // the SIGTERM that deadline sent.
    const shell = fakeShell(
      'trap \'\' TERM\nread answer\necho "__GENIRO_PATH__/a:/b"',
    );
    const started = Date.now();

    const path = await loginShellPath(5000, shell);

    expect(path).toBe('/a:/b');
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('KILLS a shell that ignores SIGTERM and never answers, and resolves null', async () => {
    const pidFile = join(scratch, 'pid');
    const shell = fakeShell(
      `echo $$ > ${JSON.stringify(pidFile)}\ntrap '' TERM\nwhile :; do sleep 1; done`,
    );
    const started = Date.now();

    const path = await loginShellPath(1500, shell);

    expect(path).toBeNull();
    expect(Date.now() - started).toBeLessThan(3500);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    // SIGKILL is delivered by the time the promise has resolved; the kernel
    // reaps asynchronously, so allow it the moment it needs.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isAlive(pid)).toBe(false);
  });

  it('does not wait for a background job that still holds the pipe once the shell has exited', async () => {
    // An rc file that starts a job without redirecting it hands that job our
    // stdout, and `close` then waits for the JOB. The echo is the shell's last
    // act, so its exit is the moment the answer is complete.
    const shell = fakeShell('(sleep 5) &\necho "__GENIRO_PATH__/a:/b"');
    const started = Date.now();

    const path = await loginShellPath(5000, shell);

    expect(path).toBe('/a:/b');
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('resolves null for a shell that cannot be started at all', async () => {
    await expect(
      loginShellPath(3000, join(scratch, 'no-such-shell')),
    ).resolves.toBeNull();
  });
});

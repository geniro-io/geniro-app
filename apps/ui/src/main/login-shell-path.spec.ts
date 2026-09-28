import { execFileSync } from 'node:child_process';
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
   * A freshly written script, run once before it is handed over. macOS assesses
   * a new executable on its first exec — measured at ~400ms before its first
   * line runs — and under a whole suite's load that stretched past a case's
   * deadline, so the script never started and the case was timing the
   * assessment and the machine instead of the code. The warm-up run exits at
   * its first line.
   *
   * The time bounds below are wide for the same reason. Each is still far
   * inside what the regression it guards would take: the old code waited for
   * the deadline, for a background job, or forever.
   */
  const fakeShell = (body: string): string => {
    const path = join(scratch, 'shell.sh');
    writeFileSync(
      path,
      `#!/bin/sh\n[ -n "$GENIRO_SPEC_WARMUP" ] && exit 0\n${body}\n`,
      { mode: 0o755 },
    );
    execFileSync(path, [], {
      env: { ...process.env, GENIRO_SPEC_WARMUP: '1' },
    });
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

    // A 20s deadline the old code would have waited out; the answer is EOF.
    const path = await loginShellPath(20_000, shell);

    expect(path).toBe('/a:/b');
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it('KILLS a shell that ignores SIGTERM and never answers, and resolves null', async () => {
    const pidFile = join(scratch, 'pid');
    const shell = fakeShell(
      `echo $$ > ${JSON.stringify(pidFile)}\ntrap '' TERM\nwhile :; do sleep 1; done`,
    );
    const started = Date.now();

    const path = await loginShellPath(4000, shell);

    expect(path).toBeNull();
    // The old code sent SIGTERM, which this shell ignores, and waited for it
    // to exit — forever.
    expect(Date.now() - started).toBeLessThan(15_000);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    // SIGKILL is delivered by the time the promise has resolved; the kernel
    // reaps asynchronously, so allow it the moment it needs.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isAlive(pid)).toBe(false);
  }, 30_000);

  it('does not wait for a background job that still holds the pipe once the shell has exited', async () => {
    // An rc file that starts a job without redirecting it hands that job our
    // stdout, and `close` then waits for the JOB. The echo is the shell's last
    // act, so its exit is the moment the answer is complete.
    const jobPidFile = join(scratch, 'job-pid');
    const shell = fakeShell(
      `(sleep 20) &\necho $! > ${JSON.stringify(jobPidFile)}\necho "__GENIRO_PATH__/a:/b"`,
    );
    const started = Date.now();

    try {
      const path = await loginShellPath(30_000, shell);

      expect(path).toBe('/a:/b');
      // The old code waited for the 20s job to let go of the pipe.
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      try {
        process.kill(Number(readFileSync(jobPidFile, 'utf8').trim()));
      } catch {
        // Already gone, or never started.
      }
    }
  }, 30_000);

  it('resolves null for a shell that cannot be started at all', async () => {
    await expect(
      loginShellPath(3000, join(scratch, 'no-such-shell')),
    ).resolves.toBeNull();
  });
});

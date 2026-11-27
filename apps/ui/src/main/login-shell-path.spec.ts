import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

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
  const BODY_ENV = 'GENIRO_SPEC_SHELL_BODY';
  let shellDir = '';
  let shell = '';
  let scratch = '';

  /**
   * One script for the whole file, run once before any case. macOS assesses a
   * new executable on its first exec — measured at 350–730ms before its first
   * line runs — so a script per case spent that on every case. Each case hands
   * the script its body through the environment, which the spawned shell
   * inherits.
   *
   * The time bounds below are wide for the machine's load. Each is still far
   * inside what the regression it guards would take: the old code waited for
   * the deadline, for a background job, or forever.
   */
  beforeAll(() => {
    shellDir = mkdtempSync(join(tmpdir(), 'geniro-login-shell-bin-'));
    shell = join(shellDir, 'shell.sh');
    writeFileSync(shell, `#!/bin/sh\neval "$${BODY_ENV}"\n`, {
      mode: 0o755,
    });
    execFileSync(shell, [], { env: { ...process.env, [BODY_ENV]: '' } });
  });

  afterAll(() => {
    rmSync(shellDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'geniro-login-shell-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true });
  });

  const fakeShell = (body: string): string => {
    vi.stubEnv(BODY_ENV, body);
    return shell;
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
    const fake = fakeShell(
      'echo "rc banner"\necho "__GENIRO_PATH__/opt/homebrew/bin:/usr/bin"',
    );

    await expect(loginShellPath(3000, fake)).resolves.toBe(
      '/opt/homebrew/bin:/usr/bin',
    );
  });

  it('answers at once when an rc file READS its stdin, rather than waiting on it', async () => {
    // With stdin an open pipe nobody writes to, a `read` in an rc file blocks
    // until the deadline — and past it, since the shell ignores a SIGTERM.
    const fake = fakeShell(
      'trap \'\' TERM\nread answer\necho "__GENIRO_PATH__/a:/b"',
    );
    const started = Date.now();

    // A 20s deadline the old code would have waited out; the answer is EOF.
    const path = await loginShellPath(20_000, fake);

    expect(path).toBe('/a:/b');
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it('KILLS a shell that ignores SIGTERM and never answers, and resolves null', async () => {
    const pidFile = join(scratch, 'pid');
    // The trap goes first, so a pid on disk proves SIGTERM was already ignored
    // when the deadline struck. The warm shell gets there in ~6ms, 150ms at
    // most under load.
    const fake = fakeShell(
      `trap '' TERM\necho $$ > ${JSON.stringify(pidFile)}\nwhile :; do sleep 1; done`,
    );
    const started = Date.now();

    const path = await loginShellPath(1500, fake);

    expect(path).toBeNull();
    // The old code sent SIGTERM, which this shell ignores, and waited for it
    // to exit — forever.
    expect(Date.now() - started).toBeLessThan(15_000);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    // SIGKILL is delivered by the time the promise has resolved; the kernel
    // reaps asynchronously, so allow it the moment it needs.
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(isAlive(pid)).toBe(false);
  }, 30_000);

  it('does not wait for a background job that still holds the pipe once the shell has exited', async () => {
    // An rc file that starts a job without redirecting it hands that job our
    // stdout, and `close` then waits for the JOB. The echo is the shell's last
    // act, so its exit is the moment the answer is complete.
    const jobPidFile = join(scratch, 'job-pid');
    const fake = fakeShell(
      `(sleep 20) &\necho $! > ${JSON.stringify(jobPidFile)}\necho "__GENIRO_PATH__/a:/b"`,
    );
    const started = Date.now();

    try {
      const path = await loginShellPath(30_000, fake);

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

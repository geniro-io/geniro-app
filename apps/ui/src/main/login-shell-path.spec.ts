import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));

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

describe('loginShellPath', () => {
  beforeEach(() => {
    mocks.execFile.mockReset();
  });

  it('resolves the parsed PATH from the shell invocation', async () => {
    mocks.execFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string) => void,
      ) => cb(null, '__GENIRO_PATH__/opt/homebrew/bin:/usr/bin\n'),
    );

    await expect(loginShellPath()).resolves.toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('resolves null on a shell failure/timeout (caller keeps inherited PATH)', async () => {
    mocks.execFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string) => void,
      ) => cb(new Error('timeout'), ''),
    );

    await expect(loginShellPath()).resolves.toBeNull();
  });
});

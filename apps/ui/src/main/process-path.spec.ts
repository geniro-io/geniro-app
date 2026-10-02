import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loginShellPath: vi.fn<() => Promise<string | null>>(),
}));

vi.mock('./login-shell-path', () => ({ loginShellPath: mocks.loginShellPath }));

describe('mergePathLists', () => {
  it('puts the login shell first and keeps every inherited entry it lacks', async () => {
    const { mergePathLists } = await import('./process-path');
    expect(
      mergePathLists('/usr/local/bin:/usr/bin', '/usr/bin:/bin:/usr/sbin'),
    ).toBe('/usr/local/bin:/usr/bin:/bin:/usr/sbin');
  });

  it('drops empty entries, which a shell would read as the cwd', async () => {
    const { mergePathLists } = await import('./process-path');
    expect(mergePathLists('/a::/b', undefined)).toBe('/a:/b');
  });
});

describe('adoptLoginShellPath', () => {
  const original = process.env.PATH;

  beforeEach(() => {
    vi.resetModules();
    mocks.loginShellPath.mockReset();
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  });

  afterEach(() => {
    process.env.PATH = original;
  });

  it('writes the login-shell PATH onto this process, where every child spawn reads it', async () => {
    mocks.loginShellPath.mockResolvedValue('/usr/local/bin:/usr/bin');
    const { adoptLoginShellPath } = await import('./process-path');

    await adoptLoginShellPath();

    expect(process.env.PATH).toBe(
      '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    );
  });

  it('asks the shell once, however many callers wait on it', async () => {
    mocks.loginShellPath.mockResolvedValue('/usr/local/bin');
    const { adoptLoginShellPath, loginShellPathSettled } =
      await import('./process-path');

    await Promise.all([
      adoptLoginShellPath(),
      adoptLoginShellPath(),
      loginShellPathSettled(),
    ]);

    expect(mocks.loginShellPath).toHaveBeenCalledTimes(1);
  });

  it('leaves PATH alone when the shell gave no answer', async () => {
    mocks.loginShellPath.mockResolvedValue(null);
    const { adoptLoginShellPath } = await import('./process-path');

    await adoptLoginShellPath();

    expect(process.env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('makes a waiter hold until the adoption has landed', async () => {
    let answer: (path: string) => void = () => {};
    mocks.loginShellPath.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { adoptLoginShellPath, loginShellPathSettled } =
      await import('./process-path');
    void adoptLoginShellPath();

    let settled = false;
    const waiting = loginShellPathSettled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    answer('/usr/local/bin');
    await waiting;
    expect(process.env.PATH?.startsWith('/usr/local/bin:')).toBe(true);
  });

  it('starts nothing when only waited on — a dev launch keeps its terminal PATH', async () => {
    const { loginShellPathSettled } = await import('./process-path');

    await loginShellPathSettled();

    expect(mocks.loginShellPath).not.toHaveBeenCalled();
  });
});

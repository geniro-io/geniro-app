import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, type Settings } from '../shared/contracts';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  /** Every execFile call, in order. */
  calls: [] as { file: string; args: string[]; env: NodeJS.ProcessEnv }[],
  /** What `resolveBinary` answers, from its (name, override) arguments. */
  resolve: (_name: string, _override?: string): string | null => null,
}));

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('./resolve-binary', () => ({
  resolveBinary: (name: string, override?: string) =>
    mocks.resolve(name, override),
}));
vi.mock('./process-path', () => ({
  loginShellPathSettled: () => Promise.resolve(),
}));

import {
  installCommand,
  installFailureReason,
  runCliInstall,
} from './cli-install';

type ExecFileCallback = (
  err: Error | null,
  result?: { stdout: string; stderr: string },
) => void;

/**
 * Drive every promisified `execFile`: the installer is the `/bin/bash` call,
 * every other file is a `--version` read of that binary.
 */
function stubExec(
  handler: (file: string, args: string[]) => { stdout: string } | Error,
): void {
  mocks.execFile.mockImplementation(
    (
      file: string,
      args: string[],
      opts: { env: NodeJS.ProcessEnv },
      cb: ExecFileCallback,
    ): void => {
      mocks.calls.push({ file, args, env: opts.env });
      const outcome = handler(file, args);
      if (outcome instanceof Error) {
        cb(outcome);
        return;
      }
      cb(null, { stdout: outcome.stdout, stderr: '' });
    },
  );
}

/** An execFile failure shaped the way node's promisified one rejects. */
function failure(fields: {
  stderr?: string;
  stdout?: string;
  killed?: boolean;
}): Error {
  return Object.assign(new Error('Command failed'), fields);
}

const installerCalls = (): { file: string; args: string[] }[] =>
  mocks.calls.filter((call) => call.file === '/bin/bash');

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.execFile.mockReset();
  mocks.resolve = () => null;
});

describe('installCommand', () => {
  it('pipes each vendor’s own script into the shell its docs name', () => {
    expect(installCommand('claude')).toBe(
      "set -o pipefail; /usr/bin/curl -fsSL 'https://claude.ai/install.sh' | /bin/bash",
    );
    expect(installCommand('cursor-agent')).toBe(
      "set -o pipefail; /usr/bin/curl -fsSL 'https://cursor.com/install' | /bin/bash",
    );
    expect(installCommand('codex')).toBe(
      "set -o pipefail; /usr/bin/curl -fsSL 'https://chatgpt.com/codex/install.sh' | /bin/sh",
    );
  });
});

describe('runCliInstall', () => {
  it('runs the installer, then reports the version the new binary answers', async () => {
    let installed = false;
    mocks.resolve = (name) => (installed ? `/home/u/.local/bin/${name}` : null);
    stubExec((file) => {
      if (file === '/bin/bash') {
        installed = true;
        return { stdout: 'Installation complete!\n' };
      }
      return { stdout: '0.162.0 (Claude Code)\n' };
    });

    await expect(runCliInstall('claude', DEFAULT_SETTINGS)).resolves.toEqual({
      kind: 'claude',
      ok: true,
      version: '0.162.0 (Claude Code)',
      path: '/home/u/.local/bin/claude',
      output: null,
      reason: null,
    });
    expect(installerCalls()).toEqual([
      {
        file: '/bin/bash',
        args: ['-c', installCommand('claude')],
        env: expect.any(Object),
      },
    ]);
  });

  it('hands the installer its vendor’s own switches, so codex does not wait on a [y/N]', async () => {
    stubExec(() => ({ stdout: '' }));

    await runCliInstall('codex', DEFAULT_SETTINGS);

    const [call] = mocks.calls.filter((c) => c.file === '/bin/bash');
    expect(call?.env.CODEX_NON_INTERACTIVE).toBe('1');
  });

  it('reports the installer’s own last line when it fails', async () => {
    stubExec(() =>
      failure({
        stderr:
          'Downloading…\ncurl: (6) Could not resolve host: downloads.claude.ai\n',
      }),
    );

    const result = await runCliInstall('claude', DEFAULT_SETTINGS);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(
      'curl: (6) Could not resolve host: downloads.claude.ai',
    );
    expect(result.output).toContain('Downloading…');
  });

  it('says the installer timed out rather than quoting a half-written line', async () => {
    stubExec(() => failure({ stderr: 'Downloading 41%', killed: true }));

    const result = await runCliInstall('cursor-agent', DEFAULT_SETTINGS);

    expect(result.reason).toBe(
      'The cursor-agent installer did not finish within 10 minutes.',
    );
  });

  it('is a failure when the installer exits cleanly but no working binary is found', async () => {
    stubExec(() => ({ stdout: 'done\n' }));

    const result = await runCliInstall('codex', DEFAULT_SETTINGS);

    expect(result).toMatchObject({
      ok: false,
      reason:
        'The installer finished, but no working codex was found afterwards.',
    });
  });

  it('names a pinned binary path that shadows the fresh install', async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      cliPaths: { codex: '/opt/old/codex' },
    };
    // The pin is executable, so detection keeps choosing it — and it is the
    // old copy macOS moved to the Trash's twin: it no longer runs.
    mocks.resolve = (_name, override) => override ?? '/home/u/.local/bin/codex';
    stubExec((file) => {
      if (file === '/bin/bash') {
        return { stdout: '' };
      }
      if (file === '/opt/old/codex') {
        return failure({ stderr: 'killed' });
      }
      return { stdout: 'codex-cli 0.162.0\n' };
    });

    const result = await runCliInstall('codex', settings);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(
      'codex was installed at /home/u/.local/bin/codex, but the binary path set for it (/opt/old/codex) does not run — clear that field to use the new one.',
    );
  });

  it('joins a second press instead of running a second installer', async () => {
    // A holder rather than a `let`: TS narrows a `let` assigned only inside a
    // callback to its initial `null` at every later read.
    const pending: { finish: (() => void) | null } = { finish: null };
    mocks.execFile.mockImplementation(
      (
        file: string,
        args: string[],
        opts: { env: NodeJS.ProcessEnv },
        cb: ExecFileCallback,
      ) => {
        mocks.calls.push({ file, args, env: opts.env });
        if (file === '/bin/bash') {
          pending.finish = () => cb(null, { stdout: '', stderr: '' });
          return;
        }
        cb(new Error('no binary'));
      },
    );

    const first = runCliInstall('claude', DEFAULT_SETTINGS);
    const second = runCliInstall('claude', DEFAULT_SETTINGS);
    await vi.waitFor(() => expect(pending.finish).not.toBeNull());
    pending.finish?.();

    expect(await second).toBe(await first);
    expect(installerCalls()).toHaveLength(1);
    // And the slot is released, so a later press runs the installer again.
    const third = runCliInstall('claude', DEFAULT_SETTINGS);
    await vi.waitFor(() => expect(installerCalls()).toHaveLength(2));
    pending.finish?.();
    expect(await third).not.toBe(await first);
  });
});

describe('installFailureReason', () => {
  it('keeps the last non-empty line, bounded', () => {
    expect(installFailureReason('a\nb\n\n')).toBe('b');
    expect(installFailureReason(`${'x'.repeat(300)}\n`)).toHaveLength(240);
    expect(installFailureReason('')).toBe('The installer failed.');
  });
});

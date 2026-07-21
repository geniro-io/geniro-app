import type { PathLike } from 'node:fs';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, type Settings } from '../shared/contracts';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  sandbox: { root: '' },
  /** Every candidate path the module handed to accessSync (its X_OK probes). */
  probed: [] as string[],
}));

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));

// accessSync is fenced into the per-test sandbox: WELL_KNOWN_DIRS points at the
// real host (~/.local/bin, /opt/homebrew/bin, …) where a dev machine very
// likely HAS a real claude binary — without the fence every "not found"
// assertion would be machine-dependent. Inside the sandbox the REAL accessSync
// runs, so the chmod-executable fixtures are genuinely probed for X_OK.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    accessSync: (path: PathLike, mode?: number): void => {
      const candidate = String(path);
      mocks.probed.push(candidate);
      if (mocks.sandbox.root && candidate.startsWith(mocks.sandbox.root)) {
        real.accessSync(path, mode);
        return;
      }
      const err = new Error(
        `ENOENT (outside spec sandbox): ${candidate}`,
      ) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    },
  };
});

import { detectClis } from './cli-detect';

type ExecFileCallback = (
  err: Error | null,
  result?: { stdout: string; stderr: string },
) => void;

/**
 * Drive the promisified `--version` probe. Under `util.promisify` of a plain
 * mock (no `promisify.custom`), the promise resolves with the first callback
 * value — so success passes the `{ stdout }` object the real execFile's custom
 * promisify contract would produce.
 */
function stubProbe(
  handler: (file: string) => { stdout: string } | Error,
): void {
  mocks.execFile.mockImplementation(
    (file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      const outcome = handler(file);
      if (outcome instanceof Error) {
        cb(outcome);
        return;
      }
      cb(null, { stdout: outcome.stdout, stderr: '' });
    },
  );
}

let root: string;

function sandboxDir(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fakeBinary(dir: string, name: string, executable = true): string {
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  // 0o644 clears every execute bit, so access(X_OK) fails even for root.
  chmodSync(path, executable ? 0o755 : 0o644);
  return path;
}

function settingsWith(cliPaths: Settings['cliPaths']): Settings {
  return { ...DEFAULT_SETTINGS, cliPaths };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'geniro-cli-detect-spec-'));
  mocks.sandbox.root = root;
  mocks.probed.length = 0;
  mocks.execFile.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.sandbox.root = '';
  rmSync(root, { recursive: true, force: true });
});

describe('detectClis', () => {
  it('prefers an executable override over the PATH scan and reports its version', async () => {
    const pathDir = sandboxDir('path-bin');
    fakeBinary(pathDir, 'claude');
    const override = fakeBinary(sandboxDir('override'), 'my-claude');
    vi.stubEnv('PATH', pathDir);
    stubProbe(() => ({ stdout: '1.2.3 (Claude Code)\nrelease notes noise\n' }));

    const [claude, cursor] = await detectClis(
      settingsWith({ claude: override }),
    );

    expect(claude).toEqual({
      kind: 'claude',
      found: true,
      path: override,
      // First stdout line only, trimmed — trailing noise never leaks into it.
      version: '1.2.3 (Claude Code)',
    });
    expect(mocks.execFile).toHaveBeenCalledWith(
      override,
      ['--version'],
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function),
    );
    // cursor-agent exists nowhere in the sandbox: not found, never probed.
    expect(cursor).toEqual({
      kind: 'cursor-agent',
      found: false,
      path: null,
      version: null,
    });
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });

  it('falls back to the PATH scan when the override is missing or not executable', async () => {
    const pathDir = sandboxDir('path-bin');
    const pathClaude = fakeBinary(pathDir, 'claude');
    const nonExecutable = fakeBinary(sandboxDir('override'), 'claude', false);
    vi.stubEnv('PATH', pathDir);
    stubProbe(() => ({ stdout: '2.0.0\n' }));

    const [viaBadMode] = await detectClis(
      settingsWith({ claude: nonExecutable }),
    );
    const [viaMissing] = await detectClis(
      settingsWith({ claude: join(root, 'nowhere', 'claude') }),
    );

    expect(viaBadMode?.found).toBe(true);
    expect(viaBadMode?.path).toBe(pathClaude);
    expect(viaMissing?.path).toBe(pathClaude);
  });

  it('skips empty/relative PATH entries and probes a duplicated dir exactly once', async () => {
    const dupDir = sandboxDir('dup'); // listed three ways below, holds no binaries
    const binDir = sandboxDir('bin');
    const claudePath = fakeBinary(binDir, 'claude');
    // `${dupDir}/.` is a deliberately unnormalized alias of dupDir — resolve()
    // must fold it into the same seen-set entry as the raw duplicates.
    vi.stubEnv(
      'PATH',
      ['', 'relative/bin', dupDir, `${dupDir}/.`, dupDir, binDir].join(':'),
    );
    stubProbe(() => ({ stdout: '3.0.0\n' }));

    const [claude] = await detectClis(settingsWith({}));

    expect(claude?.path).toBe(claudePath);
    // De-dup: the same normalized dir, listed 3×, yields ONE probe per kind.
    expect(
      mocks.probed.filter((p) => p === join(dupDir, 'claude')),
    ).toHaveLength(1);
    // Empty + relative entries never yield a candidate: every probe is an
    // absolute path, and none was resolved against the cwd (which is where
    // resolve('') / resolve('relative/bin') would land).
    expect(mocks.probed.every((p) => isAbsolute(p))).toBe(true);
    expect(mocks.probed.some((p) => p.startsWith(process.cwd() + sep))).toBe(
      false,
    );
  });

  it('demotes found to false — keeping the resolved path — when the --version probe fails', async () => {
    const binDir = sandboxDir('bin');
    const claudePath = fakeBinary(binDir, 'claude');
    vi.stubEnv('PATH', binDir);
    stubProbe(() =>
      Object.assign(new Error('spawn ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    );

    const [claude] = await detectClis(settingsWith({}));

    expect(claude).toEqual({
      kind: 'claude',
      found: false,
      // The path survives so the UI can show WHICH binary failed to answer.
      path: claudePath,
      version: null,
    });
  });
});

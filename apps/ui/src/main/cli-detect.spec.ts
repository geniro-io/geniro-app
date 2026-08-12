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
import { CLAUDE_ONLY_KEYS, CURSOR_ONLY_KEYS } from './probe-env';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  sandbox: { root: '' },
  /** Every candidate path the module handed to accessSync (its X_OK probes). */
  probed: [] as string[],
  /** Every (path, args) pair execFile was actually invoked with. */
  calls: [] as {
    path: string;
    args: string[];
    options?: { env?: NodeJS.ProcessEnv };
  }[],
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
 * Drive every promisified `execFile` call `detectClis` makes — both the
 * `--version` probe and (for a kind with a `LOGIN_PROBES` entry) the sign-in
 * probe, distinguished by `args` since both run against the same binary.
 * Under `util.promisify` of a plain mock (no `promisify.custom`), the promise
 * resolves with the first callback value — so success passes the `{ stdout }`
 * object the real execFile's custom promisify contract would produce.
 */
function stubExec(
  handler: (
    file: string,
    args: string[],
  ) => { stdout: string; stderr?: string } | Error,
): void {
  mocks.execFile.mockImplementation(
    (
      file: string,
      args: string[],
      opts: { env?: NodeJS.ProcessEnv } | undefined,
      cb: ExecFileCallback,
    ) => {
      mocks.calls.push({ path: file, args, options: opts });
      const outcome = handler(file, args);
      if (outcome instanceof Error) {
        cb(outcome);
        return;
      }
      cb(null, { stdout: outcome.stdout, stderr: outcome.stderr ?? '' });
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
  mocks.calls.length = 0;
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
    stubExec(() => ({ stdout: '1.2.3 (Claude Code)\nrelease notes noise\n' }));

    const [claude, cursor] = await detectClis(
      settingsWith({ claude: override }),
    );

    expect(claude).toEqual({
      kind: 'claude',
      found: true,
      path: override,
      // First stdout line only, trimmed — trailing noise never leaks into it.
      version: '1.2.3 (Claude Code)',
      // claude has no LOGIN_PROBES entry — its credentials travel as env vars
      // the daemon manages, so there is no equivalent question to ask it.
      loggedIn: null,
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
      loggedIn: null,
    });
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });

  it('falls back to the PATH scan when the override is missing or not executable', async () => {
    const pathDir = sandboxDir('path-bin');
    const pathClaude = fakeBinary(pathDir, 'claude');
    const nonExecutable = fakeBinary(sandboxDir('override'), 'claude', false);
    vi.stubEnv('PATH', pathDir);
    stubExec(() => ({ stdout: '2.0.0\n' }));

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
    stubExec(() => ({ stdout: '3.0.0\n' }));

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
    stubExec(() =>
      Object.assign(new Error('spawn ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    );

    const [claude] = await detectClis(settingsWith({}));

    expect(claude).toEqual({
      kind: 'claude',
      found: false,
      // The path survives so the UI can show WHICH binary failed to answer.
      path: claudePath,
      version: null,
      loggedIn: null,
    });
  });

  describe('sign-in status (cursor-agent)', () => {
    it("reads the CLI's structured answer, not its prose", async () => {
      const binDir = sandboxDir('bin');
      fakeBinary(binDir, 'cursor-agent');
      vi.stubEnv('PATH', binDir);
      stubExec((_file, args) =>
        args[0] === 'status'
          ? {
              stdout: JSON.stringify({
                status: 'authenticated',
                isAuthenticated: true,
                hasAccessToken: true,
              }),
            }
          : { stdout: '2026.08.11-e8db854\n' },
      );

      const [, cursor] = await detectClis(settingsWith({}));

      expect(cursor?.loggedIn).toBe(true);
      // `--format json` is the whole point: drop it and the probe is back to
      // matching human wording, which has a third state it cannot express.
      expect(
        mocks.calls.some(
          (c) =>
            c.path.endsWith('cursor-agent') &&
            c.args.join(' ') === 'status --format json',
        ),
      ).toBe(true);
    });

    it('reports false when the CLI says isAuthenticated: false', async () => {
      const binDir = sandboxDir('bin');
      fakeBinary(binDir, 'cursor-agent');
      vi.stubEnv('PATH', binDir);
      stubExec((_file, args) =>
        args[0] === 'status'
          ? {
              stdout: JSON.stringify({
                status: 'unauthenticated',
                isAuthenticated: false,
              }),
            }
          : { stdout: '2026.08.11-e8db854\n' },
      );

      const [, cursor] = await detectClis(settingsWith({}));

      expect(cursor?.loggedIn).toBe(false);
    });

    it('reports false for a PARTIALLY authenticated session', async () => {
      // The state that broke the prose matcher, and the reason this probe reads
      // a boolean. `cursor-agent` has a third status — `partially-authenticated`
      // (access token, no refresh token) — whose message is "Partially
      // authenticated (missing refresh token)". That matched neither wording, so
      // the chip rendered READY for an account whose own answer was
      // isAuthenticated:false, and turns then failed on Authentication required.
      const binDir = sandboxDir('bin');
      fakeBinary(binDir, 'cursor-agent');
      vi.stubEnv('PATH', binDir);
      stubExec((_file, args) =>
        args[0] === 'status'
          ? {
              stdout: JSON.stringify({
                status: 'partially-authenticated',
                isAuthenticated: false,
                hasAccessToken: true,
                hasRefreshToken: false,
                message: 'Partially authenticated (missing refresh token)',
              }),
            }
          : { stdout: '2026.08.11-e8db854\n' },
      );

      const [, cursor] = await detectClis(settingsWith({}));

      expect(cursor?.loggedIn).toBe(false);
    });

    // Never a guessed false: an answer this probe cannot read must not tell a
    // signed-in user to sign in. Each row enters a DIFFERENT guard — the throw,
    // the non-object check, and the missing-boolean check. Without the last two,
    // rewriting the return as `Boolean(value)` (the exact mistake the doc block
    // warns about) keeps every other sign-in test green.
    it.each([
      ['output that is not JSON at all', 'Status check error: unreachable\n'],
      ['a JSON reply that is not an object', 'null'],
      ['a JSON object with no such boolean', '{"status":"unauthenticated"}'],
      ['a boolean field of the wrong type', '{"isAuthenticated":"yes"}'],
    ])('reports null for %s', async (_label, statusStdout) => {
      const binDir = sandboxDir('bin');
      fakeBinary(binDir, 'cursor-agent');
      vi.stubEnv('PATH', binDir);
      stubExec((_file, args) =>
        args[0] === 'status'
          ? { stdout: statusStdout }
          : { stdout: '2026.08.11-e8db854\n' },
      );

      const [, cursor] = await detectClis(settingsWith({}));

      expect(cursor?.loggedIn).toBeNull();
    });

    it("withholds the other agent's credentials from the probe child", async () => {
      // The daemon strips these from every child it spawns; this process had no
      // such gate, so a login probe — an authenticated call that talks to the
      // vendor — ran holding the rival agent's token. Twin of child-env.ts.
      const binDir = sandboxDir('bin');
      fakeBinary(binDir, 'claude');
      fakeBinary(binDir, 'cursor-agent');
      vi.stubEnv('PATH', binDir);
      // Stub EVERY member of both lists, so a name added to either is covered
      // by construction. Naming a chosen pair here would leave the rest
      // deletable with nothing going red — and `child-env.ts` records that two
      // of the Anthropic names were once omitted on the daemon side exactly
      // that way.
      for (const key of [...CLAUDE_ONLY_KEYS, ...CURSOR_ONLY_KEYS]) {
        vi.stubEnv(key, `value-of-${key}`);
      }
      stubExec((_file, args) =>
        args[0] === 'status'
          ? { stdout: JSON.stringify({ isAuthenticated: true }) }
          : { stdout: 'some-version\n' },
      );

      await detectClis(settingsWith({}));

      const cursorCalls = mocks.calls.filter((c) =>
        c.path.endsWith('cursor-agent'),
      );
      const claudeCalls = mocks.calls.filter((c) => c.path.endsWith('claude'));
      expect(cursorCalls.length).toBeGreaterThan(0);
      expect(claudeCalls.length).toBeGreaterThan(0);

      // Each keeps its OWN credentials and is denied the other's. Both
      // directions, because the point is not stripping every secret — it is
      // that neither agent's binary sees the other's.
      for (const call of cursorCalls) {
        for (const key of CLAUDE_ONLY_KEYS) {
          expect(call.options?.env?.[key]).toBeUndefined();
        }
        for (const key of CURSOR_ONLY_KEYS) {
          expect(call.options?.env?.[key]).toBe(`value-of-${key}`);
        }
      }
      for (const call of claudeCalls) {
        for (const key of CURSOR_ONLY_KEYS) {
          expect(call.options?.env?.[key]).toBeUndefined();
        }
        for (const key of CLAUDE_ONLY_KEYS) {
          expect(call.options?.env?.[key]).toBe(`value-of-${key}`);
        }
      }
    });

    it('reports null — never a guessed false — when the status probe itself fails', async () => {
      const binDir = sandboxDir('bin');
      fakeBinary(binDir, 'cursor-agent');
      vi.stubEnv('PATH', binDir);
      stubExec((_file, args) =>
        args[0] === 'status'
          ? Object.assign(new Error('spawn ETIMEDOUT'), { code: 'ETIMEDOUT' })
          : { stdout: '2026.08.04-aaa8809\n' },
      );

      const [, cursor] = await detectClis(settingsWith({}));

      // A failed probe must not read as signed-out: that would tell an
      // already signed-in user to sign in, over a control that fixes nothing.
      expect(cursor?.loggedIn).toBeNull();
      // The version probe still succeeded independently of the login one.
      expect(cursor?.found).toBe(true);
    });
  });
});

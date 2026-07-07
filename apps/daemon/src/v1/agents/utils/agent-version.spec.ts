import type { execFile } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { resolveAgentVersion } from './agent-version';

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

/** Fake execFile that immediately answers with the given outcome. */
function fakeExec(outcome: { err?: Error; stdout?: string }): typeof execFile {
  return ((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
    cb(outcome.err ?? null, outcome.stdout ?? '', '');
    return { pid: 123 } as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile;
}

describe('resolveAgentVersion', () => {
  it('returns the first non-empty stdout line, trimmed', async () => {
    const version = await resolveAgentVersion('cursor-agent', {
      execFileFn: fakeExec({
        stdout: '\n  2026.06.24-abc123  \nupdate available\n',
      }),
    });
    expect(version).toBe('2026.06.24-abc123');
  });

  it('returns null when the CLI errors or times out (unknown ≠ unsupported)', async () => {
    const version = await resolveAgentVersion('cursor-agent', {
      execFileFn: fakeExec({ err: new Error('ETIMEDOUT') }),
    });
    expect(version).toBeNull();
  });

  it('returns null on empty stdout', async () => {
    const version = await resolveAgentVersion('cursor-agent', {
      execFileFn: fakeExec({ stdout: '\n\n' }),
    });
    expect(version).toBeNull();
  });

  it('resolves the binary through the Settings override env and hands the child to onSpawn', async () => {
    const seen: { cmd?: string; child?: unknown } = {};
    const execFileFn = ((
      cmd: string,
      _args: string[],
      _opts: unknown,
      cb: ExecCallback,
    ) => {
      seen.cmd = cmd;
      cb(null, '1.0.0', '');
      return { pid: 7 } as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile;
    vi.stubEnv('GENIRO_CURSOR_BIN', '/opt/custom/cursor-agent');
    try {
      await resolveAgentVersion('cursor-agent', {
        execFileFn,
        onSpawn: (child) => {
          seen.child = child;
        },
      });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(seen.cmd).toBe('/opt/custom/cursor-agent');
    expect(seen.child).toEqual({ pid: 7 });
  });
});

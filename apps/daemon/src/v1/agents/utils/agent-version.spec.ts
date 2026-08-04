import type { execFile } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { spawnAgentVersion } from './agent-version';

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

/** Fake execFile that immediately answers with the given outcome. */
function fakeExec(outcome: { err?: Error; stdout?: string }): typeof execFile {
  return ((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
    cb(outcome.err ?? null, outcome.stdout ?? '', '');
    return { pid: 123 } as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile;
}

describe('spawnAgentVersion', () => {
  it('returns the first non-empty stdout line, trimmed', async () => {
    const version = await spawnAgentVersion('/usr/bin/cursor-agent', {
      execFileFn: fakeExec({
        stdout: '\n  2026.06.24-abc123  \nupdate available\n',
      }),
    });
    expect(version).toBe('2026.06.24-abc123');
  });

  it('returns null when the CLI errors or times out (unknown ≠ unsupported)', async () => {
    const version = await spawnAgentVersion('/usr/bin/cursor-agent', {
      execFileFn: fakeExec({ err: new Error('ETIMEDOUT') }),
    });
    expect(version).toBeNull();
  });

  it('returns null on empty stdout', async () => {
    const version = await spawnAgentVersion('/usr/bin/cursor-agent', {
      execFileFn: fakeExec({ stdout: '\n\n' }),
    });
    expect(version).toBeNull();
  });

  it('strips daemon-only GENIRO_ values from the version child environment', async () => {
    const seen: { env?: NodeJS.ProcessEnv } = {};
    const execFileFn = ((
      _cmd: string,
      _args: string[],
      opts: { env?: NodeJS.ProcessEnv },
      cb: ExecCallback,
    ) => {
      seen.env = opts.env;
      cb(null, '1.0.0', '');
      return { pid: 7 } as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile;
    vi.stubEnv('GENIRO_CURSOR_API_KEY', 'must-not-leak');
    vi.stubEnv('NORMAL_VAR', 'keep-me');
    try {
      await spawnAgentVersion('/usr/bin/cursor-agent', { execFileFn });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(seen.env?.NORMAL_VAR).toBe('keep-me');
    expect(seen.env?.GENIRO_CURSOR_API_KEY).toBeUndefined();
  });

  it('hands the spawned child to onSpawn so the caller can register it', async () => {
    // Every child the daemon spawns must be reapable on shutdown, and this one
    // is spawned deep inside a promise — `onSpawn` is the only handle a caller
    // ever gets.
    const seen: { cmd?: string; child?: unknown; spawnInfo?: unknown } = {};
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

    await spawnAgentVersion('/opt/custom/cursor-agent', {
      execFileFn,
      onSpawn: (child, spawnInfo) => {
        seen.child = child;
        seen.spawnInfo = spawnInfo;
      },
    });

    // Spawned VERBATIM: resolving a kind to a binary belongs to the service,
    // so anything this function did to the string would be a second, silent
    // resolution.
    expect(seen.cmd).toBe('/opt/custom/cursor-agent');
    expect(seen.child).toEqual({ pid: 7 });
    // The SPAWN states whether the child leads a group; the registration site
    // cannot know. `execFile` never forwards `detached`, so this one does not
    // — and saying so here is what stops four consumers each hand-writing it,
    // and each keeping a single-pid cancel if that ever changes.
    expect(seen.spawnInfo).toEqual({ processGroup: false });
  });
});

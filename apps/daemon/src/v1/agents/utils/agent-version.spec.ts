import type { execFile } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAgentVersionCache, resolveAgentVersion } from './agent-version';

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

/** Fake execFile that immediately answers with the given outcome. */
function fakeExec(outcome: { err?: Error; stdout?: string }): typeof execFile {
  return ((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
    cb(outcome.err ?? null, outcome.stdout ?? '', '');
    return { pid: 123 } as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile;
}

describe('resolveAgentVersion', () => {
  // The memo is module state shared by every consumer, so a spec that left an
  // entry behind would answer the NEXT spec's question with its own version.
  beforeEach(() => resetAgentVersionCache());
  afterEach(() => {
    resetAgentVersionCache();
    vi.useRealTimers();
  });

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
      await resolveAgentVersion('cursor-agent', { execFileFn });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(seen.env?.NORMAL_VAR).toBe('keep-me');
    expect(seen.env?.GENIRO_CURSOR_API_KEY).toBeUndefined();
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

  it('asks the binary ONCE for a burst of callers, then serves the memo', async () => {
    // The finding this closes: the version resolves BEFORE any consumer's
    // cache key is computable, so every cache HIT still paid for a fork — and
    // on a hit that fork was the whole request. Both renderer hooks hold no
    // cache of their own, so a chat switch, folder change, Refresh, toggle
    // write and debounced builder selection each forked a CLI.
    let forks = 0;
    const execFileFn = ((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: ExecCallback,
    ) => {
      forks += 1;
      cb(null, '2.1.220 (Claude Code)', '');
      return { pid: 1 } as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile;

    const first = await resolveAgentVersion('claude', { execFileFn });
    const second = await resolveAgentVersion('claude', { execFileFn });

    expect([first, second]).toEqual([
      '2.1.220 (Claude Code)',
      '2.1.220 (Claude Code)',
    ]);
    expect(forks).toBe(1);
  });

  it('collapses CONCURRENT callers into a single flight', async () => {
    // The memo alone does not cover this: N requests that arrive before the
    // first answer lands would each miss and fork. Opening the agents panel
    // asks for two CLIs' listings at once, which is exactly that shape.
    let forks = 0;
    const pending: ExecCallback[] = [];
    const execFileFn = ((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: ExecCallback,
    ) => {
      forks += 1;
      pending.push(cb);
      return { pid: 1 } as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile;

    const all = Promise.all([
      resolveAgentVersion('claude', { execFileFn }),
      resolveAgentVersion('claude', { execFileFn }),
      resolveAgentVersion('claude', { execFileFn }),
    ]);
    expect(forks).toBe(1);
    pending[0]!(null, '2.1.220 (Claude Code)', '');

    expect(await all).toEqual([
      '2.1.220 (Claude Code)',
      '2.1.220 (Claude Code)',
      '2.1.220 (Claude Code)',
    ]);
    expect(forks).toBe(1);
  });

  it('keys the memo by BINARY, so two CLIs never answer for each other', async () => {
    const seen: string[] = [];
    const execFileFn = ((
      cmd: string,
      _args: string[],
      _opts: unknown,
      cb: ExecCallback,
    ) => {
      seen.push(cmd);
      cb(null, `version-of-${cmd}`, '');
      return { pid: 1 } as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile;

    const claude = await resolveAgentVersion('claude', { execFileFn });
    const cursor = await resolveAgentVersion('cursor-agent', { execFileFn });

    expect(seen).toHaveLength(2);
    expect(claude).not.toBe(cursor);
  });

  it('asks again once the memo goes stale, so an upgrade is noticed', async () => {
    // The version IS every downstream cache's key. A memo that never expired
    // would keep serving the pre-upgrade key and pin models / skills / MCP
    // answers to a binary the user has already replaced.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let forks = 0;
    const execFileFn = ((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: ExecCallback,
    ) => {
      forks += 1;
      cb(null, `v${forks}`, '');
      return { pid: 1 } as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile;

    expect(await resolveAgentVersion('claude', { execFileFn })).toBe('v1');
    vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
    expect(await resolveAgentVersion('claude', { execFileFn })).toBe('v1');
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
    expect(await resolveAgentVersion('claude', { execFileFn })).toBe('v2');
    expect(forks).toBe(2);
  });

  it('forceRefresh asks the binary even when the memo is warm', async () => {
    // The MCP listing's own Refresh: the user asked for a re-read because they
    // believe the machine changed, and the version is part of the key that
    // read is cached under — serving a memoized one would re-derive the same
    // key and hand back the very answer they asked to replace.
    let forks = 0;
    const execFileFn = ((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: ExecCallback,
    ) => {
      forks += 1;
      cb(null, `v${forks}`, '');
      return { pid: 1 } as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile;

    expect(await resolveAgentVersion('claude', { execFileFn })).toBe('v1');
    expect(
      await resolveAgentVersion('claude', { execFileFn, forceRefresh: true }),
    ).toBe('v2');
    // And the forced answer replaces the memo, rather than sitting beside it.
    expect(await resolveAgentVersion('claude', { execFileFn })).toBe('v2');
    expect(forks).toBe(2);
  });
});

import type { execFile } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentVersionService } from './agent-version.service';

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

afterEach(() => vi.useRealTimers());

/**
 * A per-instance cache is the whole reason this is a service: each spec builds
 * its own and nothing leaks between them, where the module-global it replaced
 * needed a reset hatch exported from production code.
 */
describe('AgentVersionService', () => {
  it('asks the binary ONCE for a burst of callers, then serves the memo', async () => {
    // The finding this closes: the version resolves BEFORE any consumer's
    // cache key is computable, so every cache HIT still paid for a fork — and
    // on a hit that fork was the whole request. Both renderer hooks hold no
    // cache of their own, so a chat switch, folder change, Refresh, toggle
    // write and debounced builder selection each forked a CLI.
    const service = new AgentVersionService();
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

    const first = await service.resolve('claude', { execFileFn });
    const second = await service.resolve('claude', { execFileFn });

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
    const service = new AgentVersionService();
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
      service.resolve('claude', { execFileFn }),
      service.resolve('claude', { execFileFn }),
      service.resolve('claude', { execFileFn }),
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
    const service = new AgentVersionService();
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

    const claude = await service.resolve('claude', { execFileFn });
    const cursor = await service.resolve('cursor-agent', { execFileFn });

    expect(seen).toHaveLength(2);
    expect(claude).not.toBe(cursor);
  });

  it('asks again once the memo goes stale, so an upgrade is noticed', async () => {
    // The version IS every downstream cache's key. A memo that never expired
    // would keep serving the pre-upgrade key and pin models / skills / MCP
    // answers to a binary the user has already replaced.
    const service = new AgentVersionService();
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

    expect(await service.resolve('claude', { execFileFn })).toBe('v1');
    vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
    expect(await service.resolve('claude', { execFileFn })).toBe('v1');
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
    expect(await service.resolve('claude', { execFileFn })).toBe('v2');
    expect(forks).toBe(2);
  });

  it('forceRefresh asks the binary even when the memo is warm', async () => {
    // The MCP listing's own Refresh: the user asked for a re-read because they
    // believe the machine changed, and the version is part of the key that
    // read is cached under — serving a memoized one would re-derive the same
    // key and hand back the very answer they asked to replace.
    const service = new AgentVersionService();
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

    expect(await service.resolve('claude', { execFileFn })).toBe('v1');
    expect(
      await service.resolve('claude', { execFileFn, forceRefresh: true }),
    ).toBe('v2');
    // And the forced answer replaces the memo, rather than sitting beside it.
    expect(await service.resolve('claude', { execFileFn })).toBe('v2');
    expect(forks).toBe(2);
  });

  it('keeps the forced answer when an ordinary read already in flight lands after it', async () => {
    // Refresh does not arrive on an idle daemon: the panel's own listing read
    // forks `--version` first, so the ordinary read is still out when the user
    // clicks. Whichever child exits LAST writes the memo, so the pre-upgrade
    // version can overwrite the forced one and be served for the whole TTL —
    // the user asked for a re-read and got the reading they asked to replace,
    // with every downstream cache re-keyed to the old binary.
    const service = new AgentVersionService();
    const pending: ExecCallback[] = [];
    const execFileFn = ((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: ExecCallback,
    ) => {
      pending.push(cb);
      return { pid: 1 } as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile;
    const neverForks = (() => {
      throw new Error('served a stale memo instead of the forced answer');
    }) as unknown as typeof execFile;

    const ordinary = service.resolve('claude', { execFileFn });
    const forced = service.resolve('claude', {
      execFileFn,
      forceRefresh: true,
    });
    expect(pending).toHaveLength(2);

    pending[1]!(null, '2.2.0 (upgraded)', '');
    expect(await forced).toBe('2.2.0 (upgraded)');
    pending[0]!(null, '2.1.0 (pre-upgrade)', '');
    expect(await ordinary).toBe('2.1.0 (pre-upgrade)');

    expect(await service.resolve('claude', { execFileFn: neverForks })).toBe(
      '2.2.0 (upgraded)',
    );
  });
  it('resolves a kind to its binary through the Settings override env', () => {
    // Binary resolution moved here with the cache, because the cache is KEYED
    // by binary: a service that resolved a different path than it memoized
    // would serve one install's version for another.
    const service = new AgentVersionService();
    const seen: string[] = [];
    const execFileFn = ((
      cmd: string,
      _args: string[],
      _opts: unknown,
      cb: ExecCallback,
    ) => {
      seen.push(cmd);
      cb(null, '1.0.0', '');
      return { pid: 7 } as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile;

    vi.stubEnv('GENIRO_CURSOR_BIN', '/opt/custom/cursor-agent');
    try {
      void service.resolve('cursor-agent', { execFileFn });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(seen).toEqual(['/opt/custom/cursor-agent']);
  });
});

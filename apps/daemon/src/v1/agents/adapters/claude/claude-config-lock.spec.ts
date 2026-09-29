import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LockOptions } from 'proper-lockfile';
import { describe, expect, it, vi } from 'vitest';

import { tempDir } from '../../__tests__/temp-dir';
import { ClaudeAdapter } from './claude.adapter';

/**
 * The lock the MCP toggle takes on `~/.claude.json`, observed at the one seam
 * that decides whether a compromised lock is survivable: the options handed to
 * `proper-lockfile`. The real package still runs underneath — the spy only
 * records what it was asked — so the toggle is exercised end to end.
 *
 * Its own file because `vi.mock` is file-wide: in `claude.adapter.spec.ts` it
 * would sit under every other test of the adapter.
 */
const { lockCalls } = vi.hoisted(() => ({
  lockCalls: [] as LockOptions[],
}));

vi.mock('proper-lockfile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('proper-lockfile')>();
  return {
    ...actual,
    lock: (file: string, options: LockOptions) => {
      lockCalls.push(options);
      return actual.lock(file, options);
    },
  };
});

/**
 * What `proper-lockfile` does with a compromised lock when it is given no
 * handler — its documented default, `(err) => { throw err; }`, which it calls
 * from a TIMER, so the throw is an uncaught exception in the daemon.
 */
const PACKAGE_DEFAULT = (err: Error): never => {
  throw err;
};

describe('ClaudeAdapter — the config lock', () => {
  it('logs a compromised lock instead of throwing it out of a timer', async () => {
    // The package's default handler throws from its lock-refresh timer, which
    // is an uncaught exception — and `crash-guards.ts` answers one by
    // SIGTERMing the daemon. So a claude process that merely held the lock too
    // long would take down every chat. The CLI passes its own handler for the
    // same reason ("Config lock compromised: …", logged).
    lockCalls.length = 0;
    const warn = vi.fn();
    const home = tempDir('claude-lock-');
    writeFileSync(join(home, '.claude.json'), '{"projects":{}}');

    await new ClaudeAdapter({
      homeDir: home,
      logger: { warn },
    }).setMcpServerEnabled('/proj', 'sentry', false);

    expect(lockCalls).toHaveLength(1);
    const onCompromised = lockCalls[0]?.onCompromised ?? PACKAGE_DEFAULT;
    expect(() => onCompromised(new Error('lock is stale'))).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lock is stale'));
  });
});

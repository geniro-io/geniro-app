import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { ProcessRegistry } from '../services/process-registry';
import { childProcessHandle } from './child-handle';

// Minimal EventEmitter-based ChildProcess fake — childProcessHandle only uses
// once('exit'/'error') and kill(), so the emitter satisfies it structurally.
class FakeUtilityChild extends EventEmitter {
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number): boolean => true);
}

function utilityChild(): { child: FakeUtilityChild; asChild: ChildProcess } {
  const child = new FakeUtilityChild();
  return { child, asChild: child as unknown as ChildProcess };
}

async function settledState(done: Promise<void>): Promise<boolean> {
  let settled = false;
  void done.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return settled;
}

describe('childProcessHandle', () => {
  it('done resolves on exit, not before', async () => {
    const { child, asChild } = utilityChild();
    const handle = childProcessHandle(asChild, { processGroup: false });

    expect(await settledState(handle.done)).toBe(false); // still running

    child.emit('exit', 0, null);
    await handle.done; // resolved — an unsettled done would time the test out
  });

  it('done resolves on error — the spawn-failure path (git missing, EACCES)', async () => {
    const { child, asChild } = utilityChild();
    const handle = childProcessHandle(asChild, { processGroup: false });

    // A child that never spawned emits 'error' and NO 'exit' — without the
    // error resolution this handle would never settle.
    child.emit('error', new Error('spawn git ENOENT'));
    await handle.done;
  });

  it('cancel sends SIGKILL — a short-lived utility child gets no grace dance', () => {
    const { child, asChild } = utilityChild();
    const handle = childProcessHandle(asChild, { processGroup: false });

    handle.cancel();

    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('cancel signals the process GROUP when the child was spawned as a leader', () => {
    // The grandchild-orphaning guard: `claude mcp list` health-checks, so it
    // forks the user's own MCP servers. A single-PID kill leaves them running
    // (kill-tree.ts states exactly this), so the group-wrapped handle must
    // reach for the negative pid and NOT fall back to child.kill.
    const { child, asChild } = utilityChild();
    Object.defineProperty(child, 'pid', { value: 4242, configurable: true });
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((): true => true);
    try {
      childProcessHandle(asChild, { processGroup: true }).cancel();

      expect(killSpy).toHaveBeenCalledExactlyOnceWith(-4242, 'SIGKILL');
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('a group cancel still kills the child directly when the group is already gone', () => {
    // killProcessGroup's fallback: without it a child whose group died first
    // (or a test fake with no pid) would never be signalled at all.
    const { child, asChild } = utilityChild();
    Object.defineProperty(child, 'pid', { value: 4243, configurable: true });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    try {
      childProcessHandle(asChild, { processGroup: true }).cancel();

      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('respondApproval is a no-op false — utility children carry no approval protocol', () => {
    const { asChild } = utilityChild();
    expect(
      childProcessHandle(asChild, { processGroup: false }).respondApproval(
        'req-1',
        true,
      ),
    ).toBe(false);
  });

  it('a spawn-failed child auto-unregisters from the ProcessRegistry, so shutdown has nothing to drain', async () => {
    // Every utility child (mcp enable, git ls-files, --version probes)
    // registers through this wrapper; a never-settling done would stall every
    // daemon shutdown for the full drain window.
    const registry = new ProcessRegistry();
    const { child, asChild } = utilityChild();
    const handle = childProcessHandle(asChild, { processGroup: false });
    registry.register('utility:probe', handle);
    expect(registry.has('utility:probe')).toBe(true);

    child.emit('error', new Error('spawn git ENOENT'));
    await handle.done;
    await Promise.resolve(); // the registry's auto-unregister finally microtask

    expect(registry.has('utility:probe')).toBe(false);
    // Nothing left to drain — shutdown resolves without waiting on the child.
    await expect(registry.onApplicationShutdown()).resolves.toBeUndefined();
  });
});

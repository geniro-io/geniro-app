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
    const handle = childProcessHandle(asChild);

    expect(await settledState(handle.done)).toBe(false); // still running

    child.emit('exit', 0, null);
    await handle.done; // resolved — an unsettled done would time the test out
  });

  it('done resolves on error — the spawn-failure path (git missing, EACCES)', async () => {
    const { child, asChild } = utilityChild();
    const handle = childProcessHandle(asChild);

    // A child that never spawned emits 'error' and NO 'exit' — without the
    // error resolution this handle would never settle.
    child.emit('error', new Error('spawn git ENOENT'));
    await handle.done;
  });

  it('cancel sends SIGKILL — a short-lived utility child gets no grace dance', () => {
    const { child, asChild } = utilityChild();
    const handle = childProcessHandle(asChild);

    handle.cancel();

    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('respondApproval is a no-op false — utility children carry no approval protocol', () => {
    const { asChild } = utilityChild();
    expect(childProcessHandle(asChild).respondApproval('req-1', true)).toBe(
      false,
    );
  });

  it('a spawn-failed child auto-unregisters from the ProcessRegistry, so shutdown has nothing to drain', async () => {
    // Every utility child (mcp enable, git ls-files, --version probes)
    // registers through this wrapper; a never-settling done would stall every
    // daemon shutdown for the full drain window.
    const registry = new ProcessRegistry();
    const { child, asChild } = utilityChild();
    const handle = childProcessHandle(asChild);
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

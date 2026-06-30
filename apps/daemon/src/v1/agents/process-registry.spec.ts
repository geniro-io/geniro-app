import { describe, expect, it, vi } from 'vitest';

import type { ExecutorHandle } from './executor.types';
import { ProcessRegistry } from './process-registry';

function fakeHandle(): {
  handle: ExecutorHandle;
  resolve: () => void;
  cancel: ReturnType<typeof vi.fn>;
} {
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  const cancel = vi.fn();
  return { handle: { done, cancel }, resolve, cancel };
}

describe('ProcessRegistry', () => {
  it('cancels the in-flight handle for a run', () => {
    const reg = new ProcessRegistry();
    const { handle, cancel } = fakeHandle();
    reg.register('run-1', handle);

    expect(reg.has('run-1')).toBe(true);
    expect(reg.cancel('run-1')).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('returns false when cancelling a run with no active turn', () => {
    const reg = new ProcessRegistry();
    expect(reg.cancel('nope')).toBe(false);
  });

  it('auto-unregisters once the turn settles', async () => {
    const reg = new ProcessRegistry();
    const { handle, resolve } = fakeHandle();
    reg.register('run-1', handle);
    expect(reg.has('run-1')).toBe(true);

    resolve();
    await handle.done;
    await Promise.resolve(); // let the .finally microtask run

    expect(reg.has('run-1')).toBe(false);
  });

  it('cancels every active turn on application shutdown', () => {
    const reg = new ProcessRegistry();
    const a = fakeHandle();
    const b = fakeHandle();
    reg.register('run-a', a.handle);
    reg.register('run-b', b.handle);

    reg.onApplicationShutdown();

    expect(a.cancel).toHaveBeenCalledOnce();
    expect(b.cancel).toHaveBeenCalledOnce();
    expect(reg.has('run-a')).toBe(false);
    expect(reg.has('run-b')).toBe(false);
  });

  it('tryClaim reserves a run atomically; a second claim fails until released', () => {
    const reg = new ProcessRegistry();
    expect(reg.tryClaim('run-1')).toBe(true);
    expect(reg.has('run-1')).toBe(true);
    // A claimed-but-not-started run cannot be claimed again.
    expect(reg.tryClaim('run-1')).toBe(false);
    // Nor cancelled (no process yet).
    expect(reg.cancel('run-1')).toBe(false);

    reg.release('run-1');
    expect(reg.has('run-1')).toBe(false);
    expect(reg.tryClaim('run-1')).toBe(true);
  });

  it('register upgrades a claim to a live handle; release no longer drops it', () => {
    const reg = new ProcessRegistry();
    const { handle, cancel } = fakeHandle();

    expect(reg.tryClaim('run-1')).toBe(true);
    reg.register('run-1', handle);
    // release only drops a bare claim, not a registered handle.
    reg.release('run-1');
    expect(reg.has('run-1')).toBe(true);
    expect(reg.cancel('run-1')).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

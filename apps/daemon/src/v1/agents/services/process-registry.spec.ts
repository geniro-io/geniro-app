import { describe, expect, it, vi } from 'vitest';

import type { AgentTurnHandle } from '../adapters/adapter.types';
import { ProcessRegistry } from './process-registry';

function fakeHandle(): {
  handle: AgentTurnHandle;
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

  it('cancels every active turn on application shutdown and awaits child exit', async () => {
    const reg = new ProcessRegistry();
    const a = fakeHandle();
    const b = fakeHandle();
    reg.register('run-a', a.handle);
    reg.register('run-b', b.handle);

    const shutdown = reg.onApplicationShutdown();
    // cancel fires synchronously before the first await.
    expect(a.cancel).toHaveBeenCalledOnce();
    expect(b.cancel).toHaveBeenCalledOnce();

    // cancel → child exits → `done` settles; shutdown then drains and clears.
    a.resolve();
    b.resolve();
    await shutdown;

    expect(reg.has('run-a')).toBe(false);
    expect(reg.has('run-b')).toBe(false);
  });

  it('tryClaim reserves a run atomically; a second claim fails until released', () => {
    const reg = new ProcessRegistry();
    expect(reg.tryClaim('run-1')).toBe(true);
    expect(reg.has('run-1')).toBe(true);
    // A claimed-but-not-started run cannot be claimed again.
    expect(reg.tryClaim('run-1')).toBe(false);
    // Cancelling it records the intent (no live process to kill yet) and reports
    // the cancel was accepted rather than silently dropped.
    expect(reg.cancel('run-1')).toBe(true);

    reg.release('run-1');
    expect(reg.has('run-1')).toBe(false);
    // release cleared the pending cancel, so a re-claim is a clean slate.
    expect(reg.tryClaim('run-1')).toBe(true);
  });

  it('register honors a cancel that arrived during the claim window', () => {
    const reg = new ProcessRegistry();
    const { handle, cancel } = fakeHandle();

    expect(reg.tryClaim('run-1')).toBe(true);
    expect(reg.cancel('run-1')).toBe(true); // pending cancel recorded
    reg.register('run-1', handle);
    // The just-registered handle is cancelled immediately, so the spawned CLI is
    // killed instead of running on past the user's Stop.
    expect(cancel).toHaveBeenCalledOnce();
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

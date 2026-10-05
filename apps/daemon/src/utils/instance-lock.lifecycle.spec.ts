import { describe, expect, it, vi } from 'vitest';

import type { AgentSessionRegistry } from '../v1/agents/services/agent-session.registry';
import type { ProcessRegistry } from '../v1/agents/services/process-registry';
import { InstanceLockLifecycle } from './instance-lock.lifecycle';

const { releaseInstanceLock } = vi.hoisted(() => ({
  releaseInstanceLock: vi.fn(),
}));
vi.mock('./instance-lock', () => ({
  DAEMON_LOCK_FILE_NAME: 'daemon.lock',
  releaseInstanceLock,
}));

describe('InstanceLockLifecycle', () => {
  it('releases the lock after signalling every kept process and draining every turn', async () => {
    let finishDrain!: () => void;
    const closeAll = vi.fn();
    const drain = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDrain = resolve;
        }),
    );
    const lifecycle = new InstanceLockLifecycle(
      {
        drain,
      } as unknown as ProcessRegistry,
      { closeAll } as unknown as AgentSessionRegistry,
    );

    const shutdown = lifecycle.onApplicationShutdown();
    await Promise.resolve();
    expect(drain).toHaveBeenCalledOnce();
    // Kept processes are signalled the moment the drain starts, not after it.
    expect(closeAll).toHaveBeenCalledOnce();
    expect(releaseInstanceLock).not.toHaveBeenCalled();

    finishDrain();
    await shutdown;
    expect(releaseInstanceLock).toHaveBeenCalledOnce();
  });
});

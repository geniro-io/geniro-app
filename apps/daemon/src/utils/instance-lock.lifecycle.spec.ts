import { describe, expect, it, vi } from 'vitest';

import type { AgentSessionRegistry } from '../v1/agents/services/agent-session.registry';
import type { ProcessRegistry } from '../v1/agents/services/process-registry';
import type { EmbeddingProcessService } from '../v1/embeddings/services/embedding-process.service';
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

  it('closes the embedding process with the kept agent processes, before the drain', async () => {
    releaseInstanceLock.mockClear();
    let finishDrain!: () => void;
    const closeAll = vi.fn();
    const embeddings = { closeAll: vi.fn() };
    const drain = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDrain = resolve;
        }),
    );
    const lifecycle = new InstanceLockLifecycle(
      { drain } as unknown as ProcessRegistry,
      { closeAll } as unknown as AgentSessionRegistry,
      embeddings as unknown as EmbeddingProcessService,
    );

    const shutdown = lifecycle.onApplicationShutdown();
    await Promise.resolve();
    expect(embeddings.closeAll).toHaveBeenCalledOnce();
    expect(releaseInstanceLock).not.toHaveBeenCalled();

    finishDrain();
    await shutdown;
    expect(releaseInstanceLock).toHaveBeenCalledOnce();
  });

  it('releases the lock only once every kept agent process has ended, after the drain too', async () => {
    releaseInstanceLock.mockClear();
    let processesEnded!: () => void;
    const closeAll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          processesEnded = resolve;
        }),
    );
    const lifecycle = new InstanceLockLifecycle(
      { drain: vi.fn(() => Promise.resolve()) } as unknown as ProcessRegistry,
      { closeAll } as unknown as AgentSessionRegistry,
    );

    const shutdown = lifecycle.onApplicationShutdown();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(releaseInstanceLock).not.toHaveBeenCalled();

    processesEnded();
    await shutdown;
    expect(releaseInstanceLock).toHaveBeenCalledOnce();
  });
});

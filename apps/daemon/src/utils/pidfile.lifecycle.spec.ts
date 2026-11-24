import { describe, expect, it, vi } from 'vitest';

import type { AgentSessionRegistry } from '../v1/agents/services/agent-session.registry';
import type { ProcessRegistry } from '../v1/agents/services/process-registry';
import type { EmbeddingProcessService } from '../v1/embeddings/services/embedding-process.service';
import { PidfileLifecycle } from './pidfile.lifecycle';

const { removePidfile } = vi.hoisted(() => ({ removePidfile: vi.fn() }));
vi.mock('./pidfile', () => ({ removePidfile }));

describe('PidfileLifecycle', () => {
  it('removes the pidfile after signalling every kept process and draining every turn', async () => {
    let finishDrain!: () => void;
    const closeAll = vi.fn();
    const drain = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDrain = resolve;
        }),
    );
    const lifecycle = new PidfileLifecycle(
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
    expect(removePidfile).not.toHaveBeenCalled();

    finishDrain();
    await shutdown;
    expect(removePidfile).toHaveBeenCalledOnce();
  });

  it('closes the embedding process with the kept agent processes, before the drain', async () => {
    removePidfile.mockClear();
    let finishDrain!: () => void;
    const closeAll = vi.fn();
    const embeddings = { closeAll: vi.fn() };
    const drain = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDrain = resolve;
        }),
    );
    const lifecycle = new PidfileLifecycle(
      { drain } as unknown as ProcessRegistry,
      { closeAll } as unknown as AgentSessionRegistry,
      embeddings as unknown as EmbeddingProcessService,
    );

    const shutdown = lifecycle.onApplicationShutdown();
    await Promise.resolve();
    expect(embeddings.closeAll).toHaveBeenCalledOnce();
    expect(removePidfile).not.toHaveBeenCalled();

    finishDrain();
    await shutdown;
    expect(removePidfile).toHaveBeenCalledOnce();
  });
});

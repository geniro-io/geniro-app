import { describe, expect, it, vi } from 'vitest';

import { ProcessRegistry } from '../v1/agents/services/process-registry';
import { WsPresenceService } from '../v1/notifications/services/ws-presence.service';
import { IdleShutdownLifecycle } from './idle-shutdown.lifecycle';

const IDLE_MS = 10_000;

function setup(idleExitMs: number | null = IDLE_MS): {
  lifecycle: IdleShutdownLifecycle;
  presence: WsPresenceService;
  processes: ProcessRegistry;
  shutdown: ReturnType<typeof vi.fn>;
  advance: (ms: number) => void;
} {
  const presence = new WsPresenceService();
  const processes = new ProcessRegistry();
  const shutdown = vi.fn();
  let clock = 1_000_000;
  const lifecycle = new IdleShutdownLifecycle(idleExitMs, presence, processes, {
    now: () => clock,
    shutdown,
    logger: { log: vi.fn() },
  });
  return {
    lifecycle,
    presence,
    processes,
    shutdown,
    advance: (ms) => {
      clock += ms;
    },
  };
}

describe('IdleShutdownLifecycle', () => {
  it('exits once the window passes with no client and no turn', () => {
    const { lifecycle, shutdown, advance } = setup();

    advance(IDLE_MS);
    lifecycle.check();

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('stays up before the window is up', () => {
    const { lifecycle, shutdown, advance } = setup();

    advance(IDLE_MS - 1);
    lifecycle.check();

    expect(shutdown).not.toHaveBeenCalled();
  });

  it('stays up while a client is connected, however long that is', () => {
    const { lifecycle, presence, shutdown, advance } = setup();
    presence.opened('socket-1');

    advance(IDLE_MS * 100);
    lifecycle.check();

    expect(shutdown).not.toHaveBeenCalled();
  });

  it('stays up while a turn is in flight, even with nobody watching', () => {
    // A workflow keeps running after its window closes. Exiting here would
    // kill work the user is waiting on.
    const { lifecycle, processes, shutdown, advance } = setup();
    processes.tryClaim('run-1');

    advance(IDLE_MS * 100);
    lifecycle.check();

    expect(shutdown).not.toHaveBeenCalled();
  });

  it('restarts the clock when a client comes back', () => {
    const { lifecycle, presence, shutdown, advance } = setup();

    advance(IDLE_MS - 1);
    presence.opened('socket-1');
    lifecycle.check(); // resets

    presence.closed('socket-1');
    advance(IDLE_MS - 1);
    lifecycle.check();
    expect(shutdown).not.toHaveBeenCalled();

    advance(1);
    lifecycle.check();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('restarts the clock when a turn ends, so the window measures REAL idleness', () => {
    const { lifecycle, processes, shutdown, advance } = setup();
    processes.tryClaim('run-1');
    advance(IDLE_MS * 5);
    lifecycle.check(); // busy: resets

    processes.release('run-1');
    advance(IDLE_MS - 1);
    lifecycle.check();

    expect(shutdown).not.toHaveBeenCalled();
  });

  it('triggers only once, even if checked again mid-shutdown', () => {
    const { lifecycle, shutdown, advance } = setup();
    advance(IDLE_MS);

    lifecycle.check();
    lifecycle.check();

    // The second check would otherwise SIGTERM a daemon already on its way out.
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('never exits when no window is configured', () => {
    // `pnpm daemon:dev` and the generate:api daemon have no client by design.
    const { lifecycle, shutdown, advance } = setup(null);

    advance(Number.MAX_SAFE_INTEGER / 2);
    lifecycle.check();

    expect(shutdown).not.toHaveBeenCalled();
  });

  it('arms no timer when no window is configured', () => {
    const { lifecycle } = setup(null);
    const spy = vi.spyOn(globalThis, 'setInterval');

    lifecycle.onApplicationBootstrap();

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('checks on its own timer once armed', () => {
    vi.useFakeTimers();
    try {
      const { lifecycle, shutdown, advance } = setup();
      lifecycle.onApplicationBootstrap();
      advance(IDLE_MS);

      vi.advanceTimersByTime(IDLE_MS);

      // Nothing called `check` by hand — the armed interval did.
      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops checking on shutdown, so a torn-down daemon never re-triggers', () => {
    vi.useFakeTimers();
    try {
      const { lifecycle, shutdown, advance } = setup();
      lifecycle.onApplicationBootstrap();

      lifecycle.onApplicationShutdown();
      advance(IDLE_MS);
      vi.advanceTimersByTime(IDLE_MS * 10);

      // With the clearInterval removed, the interval above fires and this is 1.
      expect(shutdown).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

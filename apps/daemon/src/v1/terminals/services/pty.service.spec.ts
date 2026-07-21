import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProcessRegistry } from '../../agents/services/process-registry';
import type { TerminalEvent } from '../terminals.types';
import { type PtyLike, PtyService } from './pty.service';

class FakePty implements PtyLike {
  pid = 4242;
  written: string[] = [];
  resized: [number, number][] = [];
  killed: (string | undefined)[] = [];
  private dataListeners: ((data: string) => void)[] = [];
  private exitListeners: ((e: { exitCode: number }) => void)[] = [];

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.push(listener);
    return { dispose: () => {} };
  }
  onExit(listener: (e: { exitCode: number }) => void): { dispose(): void } {
    this.exitListeners.push(listener);
    return { dispose: () => {} };
  }
  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows]);
  }
  kill(signal?: string): void {
    this.killed.push(signal);
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }
  emitExit(exitCode: number): void {
    for (const listener of this.exitListeners) {
      listener({ exitCode });
    }
  }
}

function build(overrides: { killEscalationMs?: number } = {}) {
  const registry = new ProcessRegistry();
  const ptys: FakePty[] = [];
  const spawns: {
    command: string;
    args: string[];
    options: { cwd: string; env: Record<string, string> };
  }[] = [];
  const service = new PtyService(registry, {
    spawnPty: (command, args, options) => {
      const pty = new FakePty();
      ptys.push(pty);
      spawns.push({ command, args, options });
      return pty;
    },
    killEscalationMs: overrides.killEscalationMs ?? 3000,
  });
  return { service, registry, ptys, spawns };
}

const INPUT = {
  runId: 'run-1',
  nodeId: null,
  command: 'claude',
  args: ['--resume', 'sess-1'],
  cwd: '/tmp',
};

describe('PtyService', () => {
  beforeEach(() => {
    process.env.GENIRO_PTY_SPEC_SECRET = 'leak-me-not';
  });
  afterEach(() => {
    delete process.env.GENIRO_PTY_SPEC_SECRET;
    vi.useRealTimers();
  });

  it('spawns with a GENIRO_-stripped env and registers under terminal:<id>', () => {
    const { service, registry, spawns } = build();
    const wire = service.create(INPUT);

    expect(spawns[0]?.command).toBe('claude');
    expect(spawns[0]?.args).toEqual(['--resume', 'sess-1']);
    expect(spawns[0]?.options.env.GENIRO_PTY_SPEC_SECRET).toBeUndefined();
    expect(spawns[0]?.options.env.TERM).toBe('xterm-256color');
    expect(wire.status).toBe('running');
    expect(registry.has(`terminal:${wire.id}`)).toBe(true);
    // The terminal claim must NOT mark the run itself busy for chat turns.
    expect(registry.has('run-1')).toBe(false);
  });

  it('buffers scrollback and streams live data after the snapshot', () => {
    const { service, ptys } = build();
    const { id } = service.create(INPUT);
    ptys[0]?.emitData('early ');

    const events: TerminalEvent[] = [];
    const snapshot = service.scrollback(id);
    const sub = service.stream(id).subscribe((e) => events.push(e));
    ptys[0]?.emitData('late');

    expect(snapshot).toBe('early ');
    expect(events).toEqual([{ kind: 'data', data: 'late' }]);
    sub.unsubscribe();
  });

  it('caps the scrollback buffer by dropping the oldest chunks', () => {
    const { service, ptys } = build();
    const { id } = service.create(INPUT);
    const chunk = 'x'.repeat(200 * 1024);
    ptys[0]?.emitData('dropped');
    ptys[0]?.emitData(chunk);
    ptys[0]?.emitData(chunk);
    ptys[0]?.emitData(chunk);

    const scrollback = service.scrollback(id);
    expect(scrollback.includes('dropped')).toBe(false);
    // The cap loop keeps shifting until the buffer fits SCROLLBACK_CAP (512K):
    // exactly the two newest 200K chunks survive. Asserting the exact survivor
    // length (not a loose upper bound) is what catches a while→if regression.
    expect(scrollback.length).toBe(2 * 200 * 1024);
    expect(scrollback.length).toBeLessThanOrEqual(512 * 1024);
  });

  it('releases the registry claim and keeps no session when the spawn throws', () => {
    const registry = new ProcessRegistry();
    // Claims are keyed by a fresh UUID per create, so "a follow-up create
    // succeeds" cannot detect a leaked claim — observe the actual claimed key.
    const claimed: string[] = [];
    const tryClaim = registry.tryClaim.bind(registry);
    vi.spyOn(registry, 'tryClaim').mockImplementation((key: string) => {
      claimed.push(key);
      return tryClaim(key);
    });
    const service = new PtyService(registry, {
      spawnPty: () => {
        throw new Error('posix_spawnp failed');
      },
    });

    expect(() => service.create(INPUT)).toThrowError(/posix_spawnp failed/);
    expect(service.list()).toEqual([]);
    expect(claimed).toHaveLength(1);
    expect(registry.has(claimed[0]!)).toBe(false);
  });

  it('kill on an unknown/disposed id is a no-op (never-throws cancel contract)', () => {
    const { service } = build();

    expect(() => service.kill('gone')).not.toThrow();
  });

  it('create during daemon shutdown reports RUN_STOPPING, not a false "already claimed"', () => {
    const { service, registry, spawns } = build();
    // tryClaim refuses once shutdown begins — the one reachable cause of a
    // refused claim, since each create keys a fresh UUID.
    void registry.onApplicationShutdown();

    expect(() => service.create(INPUT)).toThrowError(
      /daemon shutdown started before the terminal could open/,
    );
    expect(spawns).toHaveLength(0);
  });

  it('a genuinely live duplicate claim still reports TERMINAL_BUSY', () => {
    // The double-spawn defense: a registry that reports the key as actively
    // claimed (not shutting down) must surface the conflict, not RUN_STOPPING.
    const registry = {
      tryClaim: () => false,
      has: () => true,
    } as unknown as ProcessRegistry;
    const service = new PtyService(registry, {
      spawnPty: () => {
        throw new Error('spawn must not be reached');
      },
    });

    expect(() => service.create(INPUT)).toThrowError(/already claimed/);
  });

  it('dispose-then-shutdown does not abort the registry cancel loop', async () => {
    const { service, registry, ptys } = build();
    const first = service.create(INPUT);
    // A second live child AFTER the disposed one in the map — the one that
    // would be orphaned if the first handle's cancel threw.
    service.create({ ...INPUT, runId: 'run-2' });

    // Dispose leaves the session mapped as `closing` while its PTY dies; the
    // handle stays registered until onExit settles it, and its shutdown cancel
    // (a second kill on the closing session) must stay a no-throw no-op.
    service.dispose(first.id);

    const shutdown = registry.onApplicationShutdown();
    // The second session MUST still receive its kill.
    expect(ptys[1]?.killed.length).toBeGreaterThan(0);
    ptys[0]?.emitExit(1);
    ptys[1]?.emitExit(1);
    await expect(shutdown).resolves.toBeUndefined();
  });

  it('forwards writes and clamps resize while running, ignores both after exit', () => {
    const { service, ptys } = build();
    const { id } = service.create(INPUT);

    service.write(id, 'ls\r');
    service.resize(id, 100000, 0);
    ptys[0]?.emitExit(0);
    service.write(id, 'ignored');
    service.resize(id, 10, 10);

    expect(ptys[0]?.written).toEqual(['ls\r']);
    expect(ptys[0]?.resized).toEqual([[500, 1]]);
  });

  it('marks the session exited, completes the stream, and frees the registry slot', async () => {
    const { service, registry, ptys } = build();
    const { id } = service.create(INPUT);
    const events: TerminalEvent[] = [];
    let completed = false;
    service.stream(id).subscribe({
      next: (e) => events.push(e),
      complete: () => {
        completed = true;
      },
    });

    ptys[0]?.emitExit(3);
    await Promise.resolve(); // let the handle's done.finally clear the slot

    expect(service.get(id)).toMatchObject({ status: 'exited', exitCode: 3 });
    expect(events.at(-1)).toEqual({ kind: 'exit', exitCode: 3 });
    expect(completed).toBe(true);
    expect(registry.has(`terminal:${id}`)).toBe(false);
  });

  it('falls back to a single-PID SIGKILL when the group is already gone', () => {
    vi.useFakeTimers();
    const { service, ptys } = build({ killEscalationMs: 1000 });
    const { id } = service.create(INPUT);
    const processKill = vi
      .spyOn(process, 'kill')
      .mockImplementation((pid: number) => {
        if (pid < 0) {
          throw new Error('ESRCH'); // group leader gone, group unkillable
        }
        return true;
      });

    service.kill(id);
    expect(ptys[0]?.killed).toHaveLength(1);
    vi.advanceTimersByTime(1100);

    expect(processKill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(processKill).toHaveBeenCalledWith(4242, 'SIGKILL');
    processKill.mockRestore();
  });

  it('evicts an exited session after the replay TTL', () => {
    vi.useFakeTimers();
    const { service, ptys } = build();
    const { id } = service.create(INPUT);

    ptys[0]?.emitExit(0);
    // Still re-attachable within the grace window…
    expect(service.get(id).status).toBe('exited');
    vi.advanceTimersByTime(31 * 60 * 1000);

    // …but evicted afterwards, so abandoned sessions can't pin scrollback
    // memory for the daemon's lifetime.
    expect(() => service.get(id)).toThrowError(
      /TERMINAL_NOT_FOUND|no terminal/,
    );
  });

  it('escalated SIGKILL reaches the whole process group, not just the session leader', () => {
    // The pty child is a session leader (pid == pgid), and a leader that
    // survived the polite SIGHUP through the whole grace window is exactly the
    // case where its forked tool/MCP grandchildren must not be left running
    // unmanaged. spawn-cli's killProcessTree escalates with
    // `process.kill(-pid, …)` (negative pid → process group) for this reason;
    // the PTY escalation path must reach the same set of processes.
    vi.useFakeTimers();
    const { service, ptys } = build({ killEscalationMs: 1000 });
    const { id } = service.create(INPUT);
    const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);

    service.kill(id);
    expect(ptys[0]?.killed).toHaveLength(1);
    vi.advanceTimersByTime(1100);

    expect(processKill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    processKill.mockRestore();
  });

  it('reaps running sessions on registry shutdown (daemon SIGTERM path)', async () => {
    const { service, registry, ptys } = build();
    service.create(INPUT);

    const shutdown = registry.onApplicationShutdown();
    expect(ptys[0]?.killed.length).toBeGreaterThan(0);
    ptys[0]?.emitExit(1);
    await shutdown;
  });

  it('dispose holds a running session as closing until its PTY exits', () => {
    const { service, ptys } = build();
    const { id } = service.create(INPUT);

    service.dispose(id);

    expect(ptys[0]?.killed.length).toBeGreaterThan(0);
    expect(service.get(id).status).toBe('closing');
    // The dying PTY still counts as busy — an instant reopen for the same
    // (run, node) must get THIS session back, not a second `--resume` spawn.
    expect(service.findRunning(INPUT.runId, INPUT.nodeId)?.id).toBe(id);
    // Idempotent while closing: no double-kill, no premature forget.
    const killsAfterFirst = ptys[0]?.killed.length;
    service.dispose(id);
    expect(ptys[0]?.killed.length).toBe(killsAfterFirst);

    ptys[0]?.emitExit(1);
    expect(service.get(id).status).toBe('exited');
    expect(service.findRunning(INPUT.runId, INPUT.nodeId)).toBeNull();
  });

  it('dispose forgets an exited session immediately', () => {
    const { service, ptys } = build();
    const { id } = service.create(INPUT);
    ptys[0]?.emitExit(0);

    service.dispose(id);

    expect(() => service.get(id)).toThrowError(
      /TERMINAL_NOT_FOUND|no terminal/,
    );
  });
});

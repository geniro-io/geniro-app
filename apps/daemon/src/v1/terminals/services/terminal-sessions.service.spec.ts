import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProcessRegistry } from '../../agents/services/process-registry';
import type { TerminalEvent } from '../terminals.types';
import {
  EXITED_SESSION_TTL_MS,
  type PtyLike,
  TerminalSessionsService,
} from './terminal-sessions.service';

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
  const service = new TerminalSessionsService(registry, {
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

describe('TerminalSessionsService', () => {
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

  it('merges caller-provided env over the stripped child env (re-injection seam)', () => {
    const { service, spawns } = build();

    service.create({ ...INPUT, env: { ANTHROPIC_API_KEY: 'sk-reinjected' } });

    // The extra env rides the spawn AND the strip still applies around it —
    // a reorder letting `input.env` bypass buildChildEnv would leak GENIRO_*.
    expect(spawns[0]?.options.env.ANTHROPIC_API_KEY).toBe('sk-reinjected');
    expect(spawns[0]?.options.env.GENIRO_PTY_SPEC_SECRET).toBeUndefined();
    expect(spawns[0]?.options.env.TERM).toBe('xterm-256color');
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
    const service = new TerminalSessionsService(registry, {
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
    const service = new TerminalSessionsService(registry, {
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
    expect(
      service.findRunning('interactive', INPUT.runId, INPUT.nodeId)?.id,
    ).toBe(id);
    // Idempotent while closing: no double-kill, no premature forget.
    const killsAfterFirst = ptys[0]?.killed.length;
    service.dispose(id);
    expect(ptys[0]?.killed.length).toBe(killsAfterFirst);

    // Explicitly closed: once the PTY dies the session is forgotten outright
    // — no 30-min exited retention pinning its scrollback for a re-attach
    // nobody will make.
    ptys[0]?.emitExit(1);
    expect(() => service.get(id)).toThrowError(
      /TERMINAL_NOT_FOUND|no terminal/,
    );
    expect(
      service.findRunning('interactive', INPUT.runId, INPUT.nodeId),
    ).toBeNull();
  });

  it('a session that exits on its own is kept for the replay TTL, then evicted', () => {
    vi.useFakeTimers();
    const { service, ptys } = build();
    const { id } = service.create(INPUT);

    ptys[0]?.emitExit(0);

    // Not explicitly closed — a re-attach can still replay the final screen.
    expect(service.get(id).status).toBe('exited');
    vi.advanceTimersByTime(EXITED_SESSION_TTL_MS - 1);
    expect(service.get(id).status).toBe('exited');
    vi.advanceTimersByTime(1);
    expect(() => service.get(id)).toThrowError(
      /TERMINAL_NOT_FOUND|no terminal/,
    );
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

describe('TerminalSessionsService — live mirror sessions', () => {
  const MIRROR = { runId: 'run-1', nodeId: null, cwd: '/proj' };

  it('replays the snapshot and then fans out live appends', () => {
    const { service } = build();
    const source = new Subject<string>();

    const wire = service.createMirror({
      ...MIRROR,
      snapshot: 'earlier output',
      source,
    });
    const seen: TerminalEvent[] = [];
    service.stream(wire.id).subscribe((event) => seen.push(event));
    source.next('and now');

    expect(wire.kind).toBe('live');
    // Buffered history and live appends are one stream, so a client attaching
    // later replays both in order.
    expect(service.scrollback(wire.id)).toBe('earlier outputand now');
    expect(seen).toEqual([{ kind: 'data', data: 'and now' }]);
  });

  it('claims no process slot — a mirror must not make its run look busy', () => {
    // It spawns nothing, so there is nothing for shutdown to reap; a claim
    // would also mark the run busy for chat turns over a session running
    // nothing.
    const { service, registry } = build();
    const wire = service.createMirror({
      ...MIRROR,
      snapshot: '',
      source: new Subject(),
    });

    expect(registry.has(`terminal:${wire.id}`)).toBe(false);
  });

  it('ignores input and resize instead of throwing', () => {
    // There is no process to type at. A throw would surface a stray keystroke
    // racing a session swap as an error the user cannot act on.
    const { service } = build();
    const wire = service.createMirror({
      ...MIRROR,
      snapshot: '',
      source: new Subject(),
    });

    expect(() => service.write(wire.id, 'hello')).not.toThrow();
    expect(() => service.resize(wire.id, 100, 40)).not.toThrow();
    expect(service.scrollback(wire.id)).toBe('');
  });

  it('settles — without any exit code — when its source ends', () => {
    // A deleted run (or an evicted buffer) completes the source. The mirror
    // must stop wearing a live badge over a buffer nothing writes to.
    const { service } = build();
    const source = new Subject<string>();
    const wire = service.createMirror({ ...MIRROR, snapshot: '', source });
    const seen: TerminalEvent[] = [];
    service.stream(wire.id).subscribe((event) => seen.push(event));

    source.complete();

    expect(service.get(wire.id).status).toBe('exited');
    // Null, not 0: nothing exited, so no code can be claimed.
    expect(service.get(wire.id).exitCode).toBeNull();
    expect(seen).toEqual([{ kind: 'exit', exitCode: null }]);
  });

  it('kills without reaching the process-group escalation', () => {
    // The guard that matters most: a null pty has no pid, and a pid-shaped
    // default reaching killProcessGroup would signal the daemon's OWN group.
    const { service } = build();
    const wire = service.createMirror({
      ...MIRROR,
      snapshot: '',
      source: new Subject(),
    });

    expect(() => service.kill(wire.id)).not.toThrow();
    expect(service.get(wire.id).status).toBe('exited');
  });

  it('forgets a disposed mirror at once — no `closing` limbo', () => {
    // The limbo exists to stop a reopen racing a second `--resume` onto one
    // CLI session, and a mirror spawns nothing there could be a second of.
    const { service } = build();
    const wire = service.createMirror({
      ...MIRROR,
      snapshot: 'x',
      source: new Subject(),
    });

    service.dispose(wire.id);

    expect(() => service.get(wire.id)).toThrow();
    expect(service.findRunning('live', MIRROR.runId, MIRROR.nodeId)).toBeNull();
  });

  it('settles only once when kill and dispose both land', () => {
    // The genuine double-entry: `kill` settles, then `dispose` calls
    // `settleMirror` again. Driving it through `source.complete()` instead
    // would prove nothing — the subject is already complete by then, so a
    // second `next` is a no-op whether or not the guard exists.
    const { service } = build();
    const wire = service.createMirror({
      ...MIRROR,
      snapshot: '',
      source: new Subject(),
    });
    const seen: TerminalEvent[] = [];
    service.stream(wire.id).subscribe((event) => seen.push(event));

    service.kill(wire.id);
    service.dispose(wire.id);

    expect(seen).toEqual([{ kind: 'exit', exitCode: null }]);
  });

  it('leaves no pending timer behind when a live mirror is disposed', () => {
    // `settleMirror` arms the replay TTL for an ABANDONED mirror; an explicit
    // dispose deletes the session immediately, so that timer would hold the
    // session — scrollback and all — for half an hour to delete a key that is
    // already gone.
    vi.useFakeTimers();
    try {
      const { service } = build();
      const wire = service.createMirror({
        ...MIRROR,
        snapshot: 'x',
        source: new Subject(),
      });

      service.dispose(wire.id);

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes nothing for an empty chunk', () => {
    // A child can flush with nothing buffered; waking every attached mirror for
    // a zero-length write is pure noise.
    const { service, ptys } = build();
    const wire = service.create(INPUT);
    const seen: TerminalEvent[] = [];
    service.stream(wire.id).subscribe((event) => seen.push(event));

    ptys[0]?.emitData('');

    expect(seen).toEqual([]);
  });

  it('is found separately from an interactive session on the same target', () => {
    // Both kinds can be open on one node at once; matching without the kind
    // would hand a live mirror to a caller asking for the interactive one.
    const { service } = build();
    const interactive = service.create(INPUT);
    const mirror = service.createMirror({
      runId: INPUT.runId,
      nodeId: INPUT.nodeId,
      cwd: INPUT.cwd,
      snapshot: '',
      source: new Subject(),
    });

    expect(service.findRunning('live', INPUT.runId, INPUT.nodeId)?.id).toBe(
      mirror.id,
    );
    expect(
      service.findRunning('interactive', INPUT.runId, INPUT.nodeId)?.id,
    ).toBe(interactive.id);
  });

  it('evicts a settled mirror after the exited-session TTL', () => {
    // A settled mirror keeps its final screen re-attachable, then goes. Unlike
    // a PTY — whose exit means a user closed a REPL — a mirror settles whenever
    // its run is deleted, so without the TTL a routine delete would pin up to a
    // full scrollback for the daemon's whole life.
    vi.useFakeTimers();
    try {
      const { service } = build();
      const source = new Subject<string>();
      const wire = service.createMirror({ ...MIRROR, snapshot: 'x', source });

      source.complete();
      expect(service.get(wire.id).status).toBe('exited');

      vi.advanceTimersByTime(EXITED_SESSION_TTL_MS + 1);
      expect(() => service.get(wire.id)).toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

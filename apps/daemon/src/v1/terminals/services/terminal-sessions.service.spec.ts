import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProcessRegistry } from '../../agents/services/process-registry';
import type { TerminalEvent } from '../terminals.types';
import {
  EXITED_SESSION_TTL_MS,
  LIVE_REFRESH_INTERVAL_MS,
  type PtyLike,
  REFRESH_INPUT_GRACE_MS,
  REFRESH_QUIET_MS,
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

function build(
  overrides: {
    killEscalationMs?: number;
    refreshQuietMs?: number;
    liveRefreshIntervalMs?: number;
    refreshInputGraceMs?: number;
  } = {},
) {
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
    ...overrides,
  });
  return { service, registry, ptys, spawns };
}

/**
 * Drive a replacement child all the way through: it draws, then goes quiet long
 * enough to be taken as finished and swapped in.
 */
function render(pty: FakePty | undefined, screen: string): void {
  pty?.emitData(screen);
  vi.advanceTimersByTime(REFRESH_QUIET_MS);
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
    expect(service.findRunning(INPUT.runId, INPUT.nodeId)?.id).toBe(id);
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
    expect(service.findRunning(INPUT.runId, INPUT.nodeId)).toBeNull();
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

describe('TerminalSessionsService — refresh keeps the mirror in step', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('respawns the SAME invocation in place, on one session', () => {
    // The defect this exists for: `claude --resume` reads the transcript once,
    // at startup — probe-measured, an already-open TUI grew by 0 bytes while a
    // headless turn ran on the same session — so the only way a mirror shows
    // what the chat has since said is to start the process over.
    const { service, ptys, spawns } = build();
    const { id } = service.create(INPUT);
    const events: TerminalEvent[] = [];
    const sub = service.stream(id).subscribe((event) => events.push(event));

    service.refresh(id, { immediate: true });
    render(ptys[1], 'the conversation, re-read');

    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.args).toEqual(spawns[0]?.args);
    // Same session, still running — the client never sees it end, so its
    // attachment and its id survive the swap.
    expect(service.get(id).status).toBe('running');
    expect(events.some((event) => event.kind === 'exit')).toBe(false);
    expect(service.scrollback(id)).toContain('the conversation, re-read');
    sub.unsubscribe();
  });

  it('keeps the CURRENT screen up until the replacement has finished drawing', () => {
    // The reason a refresh is spawn-first. A re-read is a cold CLI start —
    // probe-measured at ~780ms to first byte and ~3.0s to a finished screen on
    // a 200KB transcript — so clearing the terminal when the refresh BEGINS
    // gave the user three seconds of blank. Nothing may reach the client until
    // there is a whole new screen to show.
    const { service, ptys } = build();
    const { id } = service.create(INPUT);
    ptys[0]?.emitData('the conversation, as it was');

    service.refresh(id, { immediate: true });
    ptys[1]?.emitData('half a re-render');

    expect(service.scrollback(id)).toBe('the conversation, as it was');
    // ...and the child holding that screen is still alive to keep serving it.
    expect(ptys[0]?.killed).toEqual([]);
  });

  it('swaps in the finished screen and retires the child it replaces', () => {
    // The replacement renders the whole conversation from the top, so the wipe
    // must land WITH it: without one the new render sits under the stale copy
    // and the user reads the transcript twice.
    const { service, ptys } = build();
    const { id } = service.create(INPUT);
    ptys[0]?.emitData('the conversation, as it was');

    service.refresh(id, { immediate: true });
    render(ptys[1], 'the conversation, re-read');

    const scrollback = service.scrollback(id);
    expect(scrollback).not.toContain('as it was');
    // The xterm "clear saved lines" extension — `2J` alone would leave the
    // stale render one scroll away.
    expect(scrollback).toContain('\u001b[3J');
    expect(scrollback).toContain('the conversation, re-read');
    expect(ptys[0]?.killed.length).toBe(1);
  });

  it('sends the wipe and the new screen as ONE write', () => {
    // Two writes cross the socket as two frames, and the client paints the
    // blank between them — a flash on every re-read, which is the artifact the
    // spawn-first swap exists to remove.
    const { service, ptys } = build();
    const { id } = service.create(INPUT);
    const chunks: string[] = [];
    const sub = service.stream(id).subscribe((event) => {
      if (event.kind === 'data') {
        chunks.push(event.data);
      }
    });

    service.refresh(id, { immediate: true });
    render(ptys[1], 'the conversation, re-read');

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('the conversation, re-read');
    sub.unsubscribe();
  });

  it('the retired child’s exit does not end the session it just handed over', () => {
    // It is killed AFTER the handover, so its exit arrives for a session that
    // has already moved on. Settling on it would close the panel every refresh.
    const { service, ptys } = build();
    const { id } = service.create(INPUT);
    service.refresh(id, { immediate: true });
    render(ptys[1], 're-read');

    ptys[0]?.emitExit(0);

    expect(service.get(id).status).toBe('running');
    // ...and the promoted child is the one now feeding the session.
    ptys[1]?.emitData(' + more');
    expect(service.scrollback(id)).toContain('re-read + more');
  });

  it('spawns the replacement at the size the panel is NOW', () => {
    // A resize goes to the live child, but the SPEC is what the next spawn
    // reads: without remembering it, every refresh dropped the terminal back to
    // 80×24 and re-wrapped the whole conversation.
    const { service, spawns } = build();
    const { id } = service.create({ ...INPUT, cols: 80, rows: 24 });
    service.resize(id, 160, 50);

    service.refresh(id, { immediate: true });

    expect(spawns[1]?.options).toMatchObject({ cols: 160, rows: 50 });
  });

  it('resizes a replacement that is still rendering', () => {
    // It is about to become what the user sees. Left at the old grid, the swap
    // would show a conversation wrapped for a width the panel no longer has.
    const { service, ptys } = build();
    const { id } = service.create({ ...INPUT, cols: 80, rows: 24 });
    service.refresh(id, { immediate: true });

    service.resize(id, 120, 40);

    expect(ptys[1]?.resized).toContainEqual([120, 40]);
  });

  it('does not stack respawns when several turns settle at once', () => {
    // A workflow settling five nodes fires five refreshes at one mirror. Each
    // would spawn another CLI.
    const { service, spawns } = build();
    const { id } = service.create(INPUT);

    service.refresh(id, { immediate: true });
    service.refresh(id, { immediate: true });
    service.refresh(id, { immediate: true });

    expect(spawns).toHaveLength(2);
  });

  it('a close DURING a refresh kills the replacement instead of promoting it', () => {
    // Otherwise the panel the user just closed comes back: the pending
    // replacement outlives the dispose and takes over a mirror nobody is
    // watching — an unmanaged CLI child, which is exactly what the process
    // registry exists to prevent.
    const { service, ptys, spawns } = build();
    const { id } = service.create(INPUT);

    service.refresh(id, { immediate: true });
    service.dispose(id);
    render(ptys[1], 'a screen nobody asked for');
    ptys[0]?.emitExit(0);

    expect(spawns).toHaveLength(2);
    expect(ptys[1]?.killed.length).toBe(1);
    expect(() => service.get(id)).toThrowError(
      /TERMINAL_NOT_FOUND|no terminal/,
    );
  });

  it('keeps the working mirror when the replacement cannot be spawned', () => {
    // A stale mirror beats a dead one. The screen the user is looking at is
    // still being served by a live child, so failing to build its successor is
    // not a reason to take it away.
    const registry = new ProcessRegistry();
    const ptys: FakePty[] = [];
    let spawnCount = 0;
    const service = new TerminalSessionsService(registry, {
      spawnPty: () => {
        if (++spawnCount > 1) {
          throw new Error('posix_spawnp failed');
        }
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    });
    const { id } = service.create(INPUT);
    const events: TerminalEvent[] = [];
    service.stream(id).subscribe((event) => events.push(event));

    service.refresh(id, { immediate: true });

    expect(service.get(id).status).toBe('running');
    expect(events.some((event) => event.kind === 'exit')).toBe(false);
    // ...and the failure did not wedge the mirror: a later refresh is allowed.
    service.refresh(id, { immediate: true });
    expect(spawnCount).toBe(3);
  });

  it('keeps the working mirror when the replacement dies before it renders', () => {
    const { service, ptys } = build();
    const { id } = service.create(INPUT);
    ptys[0]?.emitData('the conversation, as it was');

    service.refresh(id, { immediate: true });
    ptys[1]?.emitExit(1);

    expect(service.get(id).status).toBe('running');
    expect(service.scrollback(id)).toContain('as it was');
  });

  it('discards a replacement that drew nothing rather than blanking the screen', () => {
    // The render deadline is a backstop for a CLI that never goes quiet, not a
    // licence to swap in an empty terminal.
    const { service, ptys } = build();
    const { id } = service.create(INPUT);
    ptys[0]?.emitData('the conversation, as it was');

    service.refresh(id, { immediate: true });
    vi.advanceTimersByTime(60_000);

    expect(service.scrollback(id)).toContain('as it was');
    expect(ptys[1]?.killed.length).toBe(1);
  });

  it('refreshes every mirror of one (run, node) and nothing else', () => {
    const { service, spawns } = build();
    const a = service.create({ ...INPUT, resumeSessionId: 'thread-a' });
    const b = service.create({ ...INPUT, resumeSessionId: 'thread-b' });
    const other = service.create({ ...INPUT, runId: 'run-2' });

    service.refreshTarget('run-1', null, { immediate: true });

    // Two threads of the node re-read; the other run's mirror is untouched.
    expect(spawns).toHaveLength(5);
    expect(service.get(a.id).status).toBe('running');
    expect(service.get(b.id).status).toBe('running');
    expect(service.get(other.id).status).toBe('running');
  });
});

describe('TerminalSessionsService — re-reading DURING a turn', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /** A session with a client attached — the state a visible panel is in. */
  function attached(overrides: Parameters<typeof build>[0] = {}) {
    const built = build(overrides);
    const { id } = built.service.create(INPUT);
    const sub = built.service.stream(id).subscribe(() => {});
    return { ...built, id, sub };
  }

  it('re-reads while the turn is still running, not only when it ends', () => {
    // The bug the user hit: the mirror was wired to the turn's SETTLE, so a
    // panel opened during a long turn sat frozen for its whole duration while
    // the chat pane beside it filled up. Probe-measured, the CLI appends to its
    // transcript as it works — a 34s turn grew 11 → 25 lines — so there is
    // genuinely something new to read the whole way through.
    const { service, spawns, id, sub } = attached();

    vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS);
    service.refresh(id);

    expect(spawns).toHaveLength(2);
    sub.unsubscribe();
  });

  it('re-reads at most once per interval however many items arrive', () => {
    // Every transcript item asks for a re-read, and a busy turn emits them in
    // bursts. Each one is a whole CLI process booting.
    const { service, ptys, spawns, id, sub } = attached();
    vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS);

    service.refresh(id);
    render(ptys[1], 'first re-read');
    service.refresh(id);
    service.refresh(id);
    service.refresh(id);

    expect(spawns).toHaveLength(2);
    sub.unsubscribe();
  });

  it('defers the re-read the throttle refused instead of dropping it', () => {
    // The item that arrives inside the interval is often the last one before a
    // long tool call; dropped, the mirror stays stale for the whole of it.
    const { service, ptys, spawns, id, sub } = attached();
    vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS);
    service.refresh(id);
    render(ptys[1], 'first re-read');

    service.refresh(id); // refused — inside the interval
    expect(spawns).toHaveLength(2);
    vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS);

    expect(spawns).toHaveLength(3);
    sub.unsubscribe();
  });

  it('does not re-read while nobody is attached', () => {
    // A re-read is a CLI start; spending one to update a screen no client is
    // subscribed to is pure cost.
    const { service, spawns } = build();
    const { id } = service.create(INPUT);
    vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS);

    service.refresh(id);

    expect(spawns).toHaveLength(1);
  });

  it('still re-reads an unattached mirror when the turn SETTLES', () => {
    // Once per turn, so it is cheap — and it is what makes a later attach show
    // the finished conversation rather than the one from before the turn.
    const { service, spawns } = build();
    const { id } = service.create(INPUT);

    service.refresh(id, { immediate: true });

    expect(spawns).toHaveLength(2);
  });

  it('backs off while the user is typing into the mirror', () => {
    // A re-spawn is a new CLI process: whatever is half-typed at the prompt
    // goes with the old one. Someone typing has taken the conversation over by
    // hand, and their line outranks an update they can see in the chat pane.
    const { service, spawns, id, sub } = attached();
    vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS);

    service.write(id, 'a half-typed thought', { typed: true });
    service.refresh(id);
    service.refresh(id, { immediate: true });

    expect(spawns).toHaveLength(1);
    sub.unsubscribe();
  });

  it('is NOT paused by the emulator answering the TUI on its own', () => {
    // The regression this pins. claude's TUI asks for Device Attributes on
    // every render and the terminal emulator answers down the SAME input
    // channel a keystroke uses. Treating that as typing re-armed the grace on
    // every render, so the conversation was never re-read again — the mirror
    // looked exactly as frozen as before any of this was built.
    const { service, spawns, id, sub } = attached();
    vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS);

    service.write(id, String.fromCharCode(27) + '[?1;2c');
    service.refresh(id);

    expect(spawns).toHaveLength(2);
    sub.unsubscribe();
  });

  it('resumes re-reading once the typing has gone stale', () => {
    const { service, spawns, id, sub } = attached();
    service.write(id, 'a half-typed thought', { typed: true });

    vi.advanceTimersByTime(REFRESH_INPUT_GRACE_MS);
    service.refresh(id);

    expect(spawns).toHaveLength(2);
    sub.unsubscribe();
  });
});

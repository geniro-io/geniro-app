import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentEvent,
  AgentSession,
  AgentTurnHandle,
  AgentTurnInput,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import {
  AgentSessionRegistry,
  MAX_LIVE_SESSIONS,
  SESSION_IDLE_MS,
} from './agent-session.registry';

const INPUT: AgentTurnInput = { prompt: 'p', cwd: '/proj' };

/** A session double that records its own lifetime, and can refuse a turn. */
class FakeSession implements AgentSession {
  closes = 0;
  turns = 0;
  refuse = false;
  closeThrows = false;
  private settle: (() => void) | null = null;

  startTurn(): AgentTurnHandle | null {
    if (this.refuse || !this.idle) {
      return null;
    }
    this.turns += 1;
    const done = new Promise<void>((resolve) => {
      this.settle = resolve;
    });
    return {
      done,
      cancel: () => this.endTurn(),
      respondApproval: () => true,
      sendUserMessage: () => true,
      setApprovalMode: () => true,
    };
  }

  /** Finish the turn in flight, as a `result` line would. */
  async endTurn(): Promise<void> {
    const settle = this.settle;
    this.settle = null;
    settle?.();
    // Let the registry's `done.then` re-arm before the caller asserts.
    await Promise.resolve();
    await Promise.resolve();
  }

  get idle(): boolean {
    // A dead process is not "alive with no turn in flight". This is the shape
    // the real session has, and the reason the registry cannot use `idle` to
    // tell a busy session from a dead one.
    return this.alive && this.settle === null;
  }

  get alive(): boolean {
    return this.closes === 0 && !this.processGone;
  }

  close(): void {
    this.closes += 1;
    this.resolveClosed();
    if (this.closeThrows) {
      throw new Error('close boom');
    }
  }

  /**
   * The process died with nobody asking it to — the cancel fallback's group
   * kill, or a crash. `closed` resolves, as the real session's does.
   */
  die(): void {
    this.processGone = true;
    this.resolveClosed();
  }

  /**
   * Dead, but the settle has not landed yet — the window in which the registry
   * still holds the entry and `closed` has not fired. This is what
   * `evictIfFull` has to cope with on its own.
   */
  dieWithoutSettling(): void {
    this.processGone = true;
  }

  private processGone = false;
  private resolveClosed!: () => void;
  closed = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });
}

/** An adapter double whose only job is to hand out sessions, one per spawn. */
function fakeAdapter(): {
  adapter: AgentAdapter;
  sessions: FakeSession[];
  next: () => FakeSession;
} {
  const sessions: FakeSession[] = [];
  const adapter = {
    startSession: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
  } as unknown as AgentAdapter;
  return { adapter, sessions, next: () => at(sessions, sessions.length - 1) };
}

const noop = (_event: AgentEvent): void => {};

/**
 * Index into a list the test has just caused to be long enough. `noUncheckedIndexedAccess`
 * makes a bare index `T | undefined`, and a `?.` chain would silently pass an
 * assertion whose subject never existed — the throw is what keeps the test honest.
 */
function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`no element at index ${index} (length ${items.length})`);
  }
  return item;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentSessionRegistry — reusing a run’s process', () => {
  it('runs the run’s next turn on the process it already has', async () => {
    // The whole point: two messages, ONE spawn. Each extra spawn is a full
    // re-boot of every MCP server the user's CLI loads.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions, next } = fakeAdapter();

    const first = registry.startTurn('run-1', adapter, INPUT, noop);
    expect(first).not.toBeNull();
    await next().endTurn();

    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(sessions).toHaveLength(1);
    expect(at(sessions, 0).turns).toBe(2);
    expect(at(sessions, 0).closes).toBe(0);
  });

  it('keeps one process per run, not one shared between runs', async () => {
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-1', adapter, INPUT, noop);
    registry.startTurn('run-2', adapter, INPUT, noop);

    expect(sessions).toHaveLength(2);
    expect(registry.liveCount).toBe(2);
  });

  it('replaces a session that refuses the turn, closing the old process', async () => {
    // A refusal means the process cannot serve this turn — a changed model or
    // folder, a dead CLI, a one-turn CLI — and none of those un-refuse later.
    // Keeping it would hold a process nothing can ever use again.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    at(sessions, 0).refuse = true;

    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(sessions).toHaveLength(2);
    expect(at(sessions, 0).closes).toBe(1);
    expect(at(sessions, 1).turns).toBe(1);
    expect(registry.liveCount).toBe(1);
  });

  it('throws rather than registering a session that refuses its FIRST turn', () => {
    // A freshly opened session always accepts one — even a spawn failure comes
    // back as a settled handle carrying an error event. A null here is a broken
    // adapter contract, and swallowing it would register a process no turn is
    // attached to.
    const registry = new AgentSessionRegistry();
    const session = new FakeSession();
    session.refuse = true;
    const adapter = {
      startSession: () => session,
    } as unknown as AgentAdapter;

    expect(() => registry.startTurn('run-1', adapter, INPUT, noop)).toThrow(
      /refused its first turn/,
    );
    expect(session.closes).toBe(1);
    expect(registry.liveCount).toBe(0);
  });
});

describe('AgentSessionRegistry — ending a process', () => {
  it('closes a session that went unused for the idle window', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();

    vi.advanceTimersByTime(SESSION_IDLE_MS);

    expect(at(sessions, 0).closes).toBe(1);
    expect(registry.liveCount).toBe(0);
  });

  it('does not close a session whose turn is still running', async () => {
    // The window is armed when a turn ENDS, so a long turn can outlive it.
    // Closing then would SIGKILL work the user is watching.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    registry.startTurn('run-1', adapter, INPUT, noop); // running again

    vi.advanceTimersByTime(SESSION_IDLE_MS * 2);

    expect(at(sessions, 0).closes).toBe(0);
  });

  it('closes the run’s process on teardown, and says nothing on a second call', () => {
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);

    registry.close('run-1');
    registry.close('run-1');
    registry.close('never-existed');

    expect(at(sessions, 0).closes).toBe(1);
    expect(registry.liveCount).toBe(0);
  });

  it('closes every process on shutdown', () => {
    // `ProcessRegistry` drains the TURNS; nothing but this ends the processes
    // they ran on, and a detached group left behind survives until reboot.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    registry.startTurn('run-2', adapter, INPUT, noop);

    registry.onApplicationShutdown();

    expect(sessions.map((s) => s.closes)).toEqual([1, 1]);
    expect(registry.liveCount).toBe(0);
  });

  it('keeps closing the rest when one session throws on close', () => {
    // The defensive branch, entered deliberately: this runs in a loop on
    // shutdown, so giving up on the first failure would orphan every later
    // process — the exact leak the loop exists to prevent.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    registry.startTurn('run-2', adapter, INPUT, noop);
    at(sessions, 0).closeThrows = true;

    registry.onApplicationShutdown();

    expect(at(sessions, 1).closes).toBe(1);
    expect(registry.liveCount).toBe(0);
  });

  it('spawns a one-shot session once shutdown has begun', () => {
    // After the shutdown hook there is nobody left to call `close()`, so a
    // process kept alive then would outlive the daemon. A turn crossing that
    // window still runs — it just does not get kept.
    const registry = new AgentSessionRegistry();
    const startSession = vi.fn(() => new FakeSession());
    const adapter = { startSession } as unknown as AgentAdapter;

    registry.onApplicationShutdown();
    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(startSession).toHaveBeenCalledWith(INPUT, { runScoped: false });
  });
});

describe('AgentSessionRegistry — the ceiling', () => {
  it('evicts the least-recently-used idle session to make room', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();

    for (let i = 0; i < MAX_LIVE_SESSIONS; i += 1) {
      registry.startTurn(`run-${i}`, adapter, INPUT, noop);
      await at(sessions, i).endTurn();
      // Distinct `lastUsedAt` values, so "least recently used" is a real order
      // rather than map-insertion luck.
      vi.advanceTimersByTime(1_000);
    }

    registry.startTurn('run-new', adapter, INPUT, noop);

    // run-0 was the oldest, and it is the one that went.
    expect(at(sessions, 0).closes).toBe(1);
    expect(at(sessions, 1).closes).toBe(0);
    expect(registry.liveCount).toBe(MAX_LIVE_SESSIONS);
  });

  it('drops a dead session rather than evicting a live one to make room for it', async () => {
    // The inverted consequence this fixes. A dead session reports `idle` false
    // — it is not "alive with no turn in flight" — so the eviction scan used to
    // skip it as though it were BUSY while still counting it against the
    // ceiling. The slot it occupied forever was paid for by a genuinely live
    // idle session being closed instead, respawning that run's CLI and
    // re-booting the user's MCP servers.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();

    for (let i = 0; i < MAX_LIVE_SESSIONS; i += 1) {
      registry.startTurn(`run-${i}`, adapter, INPUT, noop);
      await at(sessions, i).endTurn();
      vi.advanceTimersByTime(1_000);
    }
    // The NEWEST session dies behind the registry's back, with its settle not
    // yet landed — so `closed` has not fired and only the eviction scan can
    // notice. It is also the least attractive eviction candidate by age, which
    // is what makes this discriminating.
    at(sessions, MAX_LIVE_SESSIONS - 1).dieWithoutSettling();

    registry.startTurn('run-new', adapter, INPUT, noop);

    expect(at(sessions, MAX_LIVE_SESSIONS - 1).closes).toBe(1);
    // The oldest LIVE session survived — under the old scan it was the one
    // that went.
    expect(at(sessions, 0).closes).toBe(0);
    expect(registry.liveCount).toBe(MAX_LIVE_SESSIONS);
  });

  it('forgets a session the moment its process dies, without waiting to be asked', async () => {
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    expect(registry.liveCount).toBe(1);

    at(sessions, 0).die();
    await Promise.resolve();
    await Promise.resolve();

    // Gone from the map, so it occupies no slot and no later turn is handed it.
    expect(registry.liveCount).toBe(0);
  });

  it('goes over the ceiling rather than killing a running turn', () => {
    // The alternative is evicting work the user is watching to make room for
    // work they just asked for — a worse trade than briefly holding one extra
    // process.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();

    for (let i = 0; i < MAX_LIVE_SESSIONS; i += 1) {
      registry.startTurn(`run-${i}`, adapter, INPUT, noop); // all still busy
    }

    registry.startTurn('run-new', adapter, INPUT, noop);

    expect(sessions.every((s) => s.closes === 0)).toBe(true);
    expect(registry.liveCount).toBe(MAX_LIVE_SESSIONS + 1);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeChild } from '../__tests__/fake-child';
import type {
  AdapterConfig,
  AgentEvent,
  AgentModel,
  AgentSession,
  AgentTurnHandle,
  AgentTurnInput,
} from '../adapters/adapter.types';
import { AgentAdapter } from '../adapters/agent-adapter';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';
import type { SpawnedProcess, SpawnFn } from '../utils/spawn-cli';
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
  /**
   * Alive but unable to serve a turn. Left false here and set by the one case
   * that needs it: `refuse` models a session that declines THIS turn (a changed
   * model, a one-turn CLI), which the registry replaces; `retired` is the
   * stronger state it must close on sight instead of counting as reusable.
   */
  retired = false;
  private settle: (() => void) | null = null;

  ask(): Promise<null> {
    return Promise.resolve(null);
  }

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
 * A REAL adapter over a synchronous child double, for the cases whose subject
 * is a session state the double above cannot hold honestly — the sessions it
 * hands out are `AgentAdapter.startSession`'s own wrapper over the real
 * `runCliSession` state machine, so what the registry is told about a process is
 * what production tells it.
 */
class SessionfulAdapter extends AgentAdapter {
  constructor(spawn: SpawnFn) {
    super({ spawn });
  }

  protected get command(): string {
    return 'sessionful-cli';
  }

  getConfig(): AdapterConfig {
    return new CursorAcpAdapter().getConfig();
  }

  protected buildArgs(): string[] {
    return [];
  }

  /** This fake CLI's whole result-line vocabulary. */
  protected mapMessage(obj: unknown): AgentEvent[] {
    const row = obj as { done?: boolean; failed?: boolean };
    if (row.done === true) {
      return [
        {
          type: 'turn_complete',
          usage: null,
          stopReason: null,
          finalText: null,
        },
      ];
    }
    if (row.failed === true) {
      return [{ type: 'error', message: 'result: is_error' }];
    }
    return [];
  }

  override listModels(): Promise<AgentModel[]> {
    return Promise.resolve([]);
  }

  protected override canHostSession(): boolean {
    return true;
  }

  protected override buildNextTurnPayload(): string {
    return 'next\n';
  }

  /** Every real CLI that hosts a session has one; without it a cancel could
   * only kill the process group, which is a different case entirely. */
  protected override buildInterruptPayload(): string {
    return 'INTERRUPT\n';
  }
}

/** One fresh child per spawn, kept in call order for the assertions. */
function recordingSpawn(): { spawn: SpawnFn; children: FakeChild[] } {
  const children: FakeChild[] = [];
  return {
    children,
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as SpawnedProcess;
    },
  };
}

/** Feed one NDJSON line to a real session's child. */
function feed(child: FakeChild, obj: unknown): void {
  child.stdout.emitData(`${JSON.stringify(obj)}\n`);
}

/** Let the registry's own `done.then` bookkeeping land before asserting. */
async function settleRegistry(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

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

    // The REPLACED session's `closed` resolves on a microtask, after its
    // successor is already in the map — so the close subscription must check
    // that the entry it is deleting is still its own. Without that guard it
    // deletes the LIVE successor here, leaving a run holding a process the
    // registry no longer tracks and `onApplicationShutdown` will never close.
    // The assertions above all run before the microtask, which is exactly why
    // deleting the guard used to leave the whole suite green.
    await Promise.resolve();
    await Promise.resolve();

    expect(registry.liveCount).toBe(1);
    expect(at(sessions, 1).closes).toBe(0);
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

  it('judges a between-turn request by the LATEST turn’s posture, not the spawn’s', async () => {
    // The session is opened once and kept for the whole run, but the approval
    // posture is a per-turn fact. Handing the spawn a bare closure froze it at
    // turn 1: a chat started in `auto` and switched to `ask` went on
    // auto-approving between-turn tool calls for the rest of the session, with
    // no card ever shown — the same silent wrong verdict the between-turn work
    // exists to end, only inverted. Every later turn reaches the session
    // through the REUSE path, which never spawns, so that path is where this
    // has to hold.
    const registry = new AgentSessionRegistry();
    const session = new FakeSession();
    let installed: ((r: { toolName: string }) => boolean | null) | undefined;
    const adapter = {
      startSession: (
        _input: AgentTurnInput,
        opts: {
          betweenTurnApproval?: (r: { toolName: string }) => boolean | null;
        },
      ) => {
        installed = opts.betweenTurnApproval;
        return session;
      },
    } as unknown as AgentAdapter;

    // Turn 1 — the run is unattended, so a between-turn permission is answered.
    registry.startTurn('run-1', adapter, INPUT, noop, () => true);
    expect(installed?.({ toolName: 'Bash' })).toBe(true);
    await session.endTurn();

    // Turn 2 — the user has taken the chip off auto. Same session, reuse path.
    registry.startTurn('run-1', adapter, INPUT, noop, () => null);
    expect(session.turns).toBe(2);
    // Read through the ORIGINAL installed callback: that is the one the live
    // process still calls, so asserting on anything else would prove nothing.
    expect(installed?.({ toolName: 'Bash' })).toBeNull();
  });

  it('leaves a caller that supplies no posture on the session’s own default', async () => {
    // `spawn-cli` still has a default for callers with no posture to offer
    // (hold a question, refuse a permission). An indirection installed
    // unconditionally would erase it by answering `null` for everything, so
    // the option must stay genuinely absent.
    const registry = new AgentSessionRegistry();
    let seen: { betweenTurnApproval?: unknown } | undefined;
    const adapter = {
      startSession: (
        _input: AgentTurnInput,
        opts: { betweenTurnApproval?: unknown },
      ) => {
        seen = opts;
        return new FakeSession();
      },
    } as unknown as AgentAdapter;

    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(seen).toBeDefined();
    expect(seen?.betweenTurnApproval).toBeUndefined();
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

  it('reclaims a stopped chat’s idle process before a warm one the user is still using', async () => {
    // Driven through the REAL session state machine rather than the double
    // above, because the state under test only exists inside `spawn-cli`: a
    // turn that was asked to stop retires its session from reuse WITHOUT
    // killing the process, so the entry goes on reporting itself alive and idle
    // while refusing every turn it is offered.
    //
    // The registry cannot see that, so the retired process is the LAST thing
    // its eviction scan considers giving up — it was used most recently. With
    // three slots, one Stop therefore costs a different chat its warm CLI:
    // that run respawns and re-boots every MCP server the user's CLI loads,
    // which is the exact harm `drops a dead session rather than evicting a
    // live one` was written to remove, reached through a new door.
    const registry = new AgentSessionRegistry();
    const { spawn, children } = recordingSpawn();
    const adapter = new SessionfulAdapter(spawn);

    // Two chats whose turns ended on their own, so both hold a healthy process.
    for (const runId of ['run-warm', 'run-other']) {
      const handle = registry.startTurn(runId, adapter, INPUT, noop);
      feed(at(children, children.length - 1), { done: true });
      await handle.done;
      await settleRegistry();
    }
    // A third chat where the user pressed Stop. The CLI acknowledges the
    // interrupt and the turn ends on it; the process is deliberately left
    // running, so nothing about this entry looks unusable from outside.
    const stopped = registry.startTurn('run-stopped', adapter, INPUT, noop);
    stopped.cancel();
    feed(at(children, 2), { failed: true });
    await stopped.done;
    await settleRegistry();
    expect(at(children, 2).kills).toBe(0);
    expect(registry.liveCount).toBe(MAX_LIVE_SESSIONS);

    // A fourth chat's first message: one slot has to be given back.
    registry.startTurn('run-new', adapter, INPUT, noop);
    // …and then the user carries on in the first chat.
    registry.startTurn('run-warm', adapter, INPUT, noop);

    // The warm chat's CLI was never signalled, so the MCP servers it is holding
    // up — and anything one of them owns, a logged-in browser included —
    // survived a Stop pressed in a different chat.
    expect(at(children, 0).kills).toBe(0);
    // And the consequence of that, stated where a reader meets it: one spawn per
    // chat, because the stopped chat's useless process is what paid for the
    // fourth slot and the warm chat answered on the CLI it already had.
    expect(children).toHaveLength(4);
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

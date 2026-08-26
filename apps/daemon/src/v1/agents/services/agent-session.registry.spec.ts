import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeChild } from '../__tests__/fake-child';
import { freshVocabularyStore } from '../adapters/__tests__/fresh-vocabulary-store';
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
import type {
  CliSessionOptions,
  SpawnedProcess,
  SpawnFn,
} from '../utils/spawn-cli';
import {
  AgentSessionRegistry,
  OFF_TURN_ACTIVE_MS,
  SESSION_IDLE_MS,
  SESSION_MEMORY_COST_BYTES,
  sessionCeilingFor,
} from './agent-session.registry';

/**
 * The ceiling every case in this file runs under, PINNED.
 *
 * The production one is derived from the machine's memory, so it is 2 on a
 * 16GB CI box and 16 on the desktop this was written on — and an eviction case
 * that builds `MAX_LIVE_SESSIONS` sessions and then asserts which of the first
 * three went would mean something different on each. The registry takes it as
 * a constructor argument for exactly this, and the derivation is pinned on its
 * own below rather than through these.
 */
const CEILING = 3;

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
  /**
   * Blocked on a verdict only the user can give. Idle in every other respect,
   * which is the whole point of the flag — the registry must reap an unused
   * session and must not reap this one.
   */
  parked = false;
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

  /**
   * The registry's own between-turn sink, captured at spawn — what the CLI
   * calls when it produces a row with no turn of ours open.
   */
  betweenTurn: ((event: AgentEvent) => void) | null = null;

  /** One off-turn row, as a delegate reporting back would produce. */
  emitBetweenTurn(name: string): void {
    this.betweenTurn?.({ type: 'tool_call', id: name, name, input: {} });
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
    startSession: (_input: AgentTurnInput, opts?: CliSessionOptions) => {
      const session = new FakeSession();
      session.betweenTurn = opts?.onBetweenTurnEvent ?? null;
      sessions.push(session);
      return session;
    },
    // The registry records which agent a session belongs to, so `markStale`
    // can find the sessions an MCP change is about. Doubles owe it too.
    getConfig: () => ({ kind: 'claude' }),
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
    return new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
    }).getConfig();
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
      // The registry records which agent a session belongs to, so `markStale`
      // can find the sessions an MCP change is about. Doubles owe it too.
      getConfig: () => ({ kind: 'claude' }),
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

  it('lets the idle farewell ask the process something before closing it', async () => {
    // The reading claude can only give while it is RUNNING — the context
    // breakdown and the plan limits — is wanted long after it stops running,
    // and this close is the last moment anything can ask for it. The session
    // must still be reachable while the question is in flight, which is what
    // the `peek` here pins.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    let release = (): void => {};
    const asked: (unknown | null)[] = [];
    registry.onIdleFarewell(async (runId) => {
      asked.push(registry.peek(runId));
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    vi.advanceTimersByTime(SESSION_IDLE_MS);

    // Still alive while the question is outstanding — closing first would
    // leave nothing to ask.
    expect(asked).toEqual([at(sessions, 0)]);
    expect(at(sessions, 0).closes).toBe(0);

    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(at(sessions, 0).closes).toBe(1);
  });

  it('abandons that close when a turn arrives while the farewell is in flight', async () => {
    // The window measures a chat going unused, and one the user has just
    // written to is not that — closing it here would take down the process the
    // turn is running on, for a question asked about the idle state it left.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    let release = (): void => {};
    registry.onIdleFarewell(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    vi.advanceTimersByTime(SESSION_IDLE_MS);
    registry.startTurn('run-1', adapter, INPUT, noop);
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(at(sessions, 0).closes).toBe(0);
    expect(registry.liveCount).toBe(1);
  });

  it('does not close a session parked on a card the user has not answered', async () => {
    // The run this was written for: claude asked a question eight minutes after
    // its turn had settled, the idle window closed the process under it, the
    // CLI read the close as a refusal, and the chat was marked failed with a
    // bare "claude run failed" for a question nobody had answered. The window
    // measures a chat going UNUSED, and one waiting on a person is not that.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    at(sessions, 0).parked = true;

    vi.advanceTimersByTime(SESSION_IDLE_MS * 3);

    expect(at(sessions, 0).closes).toBe(0);
    expect(registry.liveCount).toBe(1);

    // And the clock resumes once they answer — the re-arm is what stops a
    // once-parked session living forever.
    at(sessions, 0).parked = false;
    vi.advanceTimersByTime(SESSION_IDLE_MS);

    expect(at(sessions, 0).closes).toBe(1);
  });

  it('does not close a session whose CLI is still producing rows between turns', async () => {
    // MEASURED on the author's own machine, run 1fb3a9f5 on 2026-08-22: a turn
    // settled at 11:03:55 and armed this window; the CLI then worked off-turn
    // for the whole thirty minutes — delegates reporting back, continuation
    // turns of its own, rows landing in the transcript the entire time — and
    // the window fired at 11:33:55, three seconds after the last row, reaping
    // a process that had been busy without pause.
    //
    // `session.idle` is why: it means "alive with no turn of OURS in flight",
    // which is true of a CLI running flat out between turns. The window
    // measures a chat going UNUSED, and one whose agent is writing rows is not
    // that — the same reading the `parked` case above already applies.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();

    // The between-turn sink is what the registry watches, so the caller has to
    // have one — `ChatService` always does, and a caller with none keeps
    // `spawn-cli`'s "dropped an event arriving between turns" warning instead.
    registry.startTurn('run-1', adapter, INPUT, noop, undefined, noop);
    await at(sessions, 0).endTurn();

    // Four half-windows of off-turn work — twice the window in total, so a
    // clock that is not re-armed has fired twice over by the end.
    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(SESSION_IDLE_MS / 2);
      at(sessions, 0).emitBetweenTurn(`Bash-${i}`);
    }

    expect(at(sessions, 0).closes).toBe(0);
    expect(registry.liveCount).toBe(1);

    // And the clock still runs out once it really does go quiet — the re-arm
    // must not turn into a session that lives for ever.
    vi.advanceTimersByTime(SESSION_IDLE_MS);

    expect(at(sessions, 0).closes).toBe(1);
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
    const adapter = {
      startSession,
      getConfig: () => ({ kind: 'claude' }),
    } as unknown as AgentAdapter;

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
      // The registry records which agent a session belongs to, so `markStale`
      // can find the sessions an MCP change is about. Doubles owe it too.
      getConfig: () => ({ kind: 'claude' }),
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
      // The registry records which agent a session belongs to, so `markStale`
      // can find the sessions an MCP change is about. Doubles owe it too.
      getConfig: () => ({ kind: 'claude' }),
    } as unknown as AgentAdapter;

    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(seen).toBeDefined();
    expect(seen?.betweenTurnApproval).toBeUndefined();
  });
});

describe('sessionCeilingFor', () => {
  const GB = SESSION_MEMORY_COST_BYTES;

  it('scales the ceiling with the machine, an eighth of memory at a time', () => {
    // The whole reason this stopped being a constant. REPORTED as "что за max
    // live session… это очень мало!" against a flat 3 on a 128GB machine,
    // where the fourth chat paid a ~6.5s cold start and a full MCP reboot with
    // 110GB sitting free. Pinned at sizes rather than as a formula, because a
    // test that recomputes the arithmetic under test passes whatever the
    // arithmetic is.
    expect(sessionCeilingFor(32 * GB)).toBe(4);
    expect(sessionCeilingFor(64 * GB)).toBe(8);
    expect(sessionCeilingFor(128 * GB)).toBe(16);
  });

  it('keeps two on a small machine rather than falling to one or none', () => {
    // At one there is nothing to keep: the benefit is a chat staying warm
    // while you work in another, and one slot means the second chat evicts the
    // first on every switch — worse than the per-turn spawn this replaced,
    // which at least did not pretend to cache anything.
    expect(sessionCeilingFor(8 * GB)).toBe(2);
    expect(sessionCeilingFor(4 * GB)).toBe(2);
    // Absurd inputs land on the floor rather than on 0 or a negative.
    expect(sessionCeilingFor(0)).toBe(2);
  });

  it('caps a very large machine instead of scaling without bound', () => {
    // Past a dozen the constraint is the person, not the hardware — these are
    // conversations somebody is meant to be following. Without the cap a 1TB
    // box would hold 128 CLI processes it was never going to use.
    expect(sessionCeilingFor(512 * GB)).toBe(16);
    expect(sessionCeilingFor(1024 * GB)).toBe(16);
  });
});

describe('AgentSessionRegistry — the ceiling', () => {
  it('evicts the least-recently-used idle session to make room', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    for (let i = 0; i < CEILING; i += 1) {
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
    expect(registry.liveCount).toBe(CEILING);
  });

  it('evicts a newer idle session rather than the oldest one holding a card', async () => {
    // `parked` is idle in the only sense `idle` claims — no turn in flight — so
    // the age scan would pick it first, being the oldest. Evicting it kills the
    // question rather than the process: the CLI takes the close as a refusal
    // and the verdict the user is about to give arrives at nothing.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    for (let i = 0; i < CEILING; i += 1) {
      registry.startTurn(`run-${i}`, adapter, INPUT, noop);
      await at(sessions, i).endTurn();
      vi.advanceTimersByTime(1_000);
    }
    at(sessions, 0).parked = true;

    registry.startTurn('run-new', adapter, INPUT, noop);

    expect(at(sessions, 0).closes).toBe(0);
    // The next-oldest went instead, so the ceiling is still enforced.
    expect(at(sessions, 1).closes).toBe(1);
    expect(registry.liveCount).toBe(CEILING);
  });

  it('evicts a newer idle session rather than the oldest one still working off-turn', async () => {
    // The reported defect, as a unit. A CLI carrying on between turns reports
    // `idle === true` — there is no turn of OURS in flight — so the age scan
    // took it, and on run 309e0822 it took the session ONE SECOND after its
    // last row: the thread then read `completed` over eleven pending tasks
    // until the user typed a message to restart it. `parked` is exempted for
    // the same reason directly above; this is the third such state.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    for (let i = 0; i < CEILING; i += 1) {
      registry.startTurn(`run-${i}`, adapter, INPUT, noop, undefined, noop);
      await at(sessions, i).endTurn();
      vi.advanceTimersByTime(1_000);
    }
    at(sessions, 0).emitBetweenTurn('Bash-1');
    // The other two are then USED, which is what makes run-0 the oldest by age
    // while being the one still working — the production shape, and the only
    // arrangement that tests anything. An off-turn row refreshes `lastUsedAt`
    // as a settling turn does, so simply touching run-0 makes it the NEWEST and
    // the scan would spare it whether or not the exemption exists.
    for (const index of [1, 2]) {
      vi.advanceTimersByTime(1_000);
      registry.startTurn(`run-${index}`, adapter, INPUT, noop, undefined, noop);
      await at(sessions, index).endTurn();
    }

    registry.startTurn('run-new', adapter, INPUT, noop, undefined, noop);

    expect(at(sessions, 0).closes).toBe(0);
    expect(at(sessions, 1).closes).toBe(1);
    expect(registry.liveCount).toBe(CEILING);
  });

  it('goes over the ceiling rather than evicting any session that is working off-turn', async () => {
    // The exemption cannot become a refusal: with every session working, the
    // scan finds no candidate and the existing all-busy arm takes over. Going
    // over is the lesser harm — the alternative is killing live work to make
    // room for work the user just asked for.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    for (let i = 0; i < CEILING; i += 1) {
      registry.startTurn(`run-${i}`, adapter, INPUT, noop, undefined, noop);
      await at(sessions, i).endTurn();
      at(sessions, i).emitBetweenTurn(`Bash-${i}`);
    }

    registry.startTurn('run-new', adapter, INPUT, noop, undefined, noop);

    for (let i = 0; i < CEILING; i += 1) {
      expect(at(sessions, i).closes).toBe(0);
    }
    expect(registry.liveCount).toBe(CEILING + 1);
  });

  it('evicts a session whose off-turn work went quiet long ago', async () => {
    // The other half of the same rule, and what stops the exemption becoming
    // permanent: one off-turn row must not make a session un-evictable for the
    // rest of the day. Past the window it is an ordinary candidate again.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    for (let i = 0; i < CEILING; i += 1) {
      registry.startTurn(`run-${i}`, adapter, INPUT, noop, undefined, noop);
      await at(sessions, i).endTurn();
      vi.advanceTimersByTime(1_000);
    }
    at(sessions, 0).emitBetweenTurn('Bash-1');
    vi.advanceTimersByTime(OFF_TURN_ACTIVE_MS + 1_000);
    // The one that worked is now the LEAST attractive candidate by age — an
    // off-turn row refreshes `lastUsedAt` as a settling turn does — so the
    // other two are parked to leave it as the only one the scan can reach.
    // Without the expiry there is no candidate at all and the registry goes
    // over the ceiling instead, which is what this separates.
    at(sessions, 1).parked = true;
    at(sessions, 2).parked = true;

    registry.startTurn('run-new', adapter, INPUT, noop, undefined, noop);

    expect(at(sessions, 0).closes).toBe(1);
    expect(registry.liveCount).toBe(CEILING);
  });

  it('tells a close listener whether the close INTERRUPTED work', async () => {
    // What the listener cannot see for itself, and what decides whether the
    // transcript owes the user a sentence: `ChatService` writes a row naming
    // the cut-off only for the first of these, because a row on every reap
    // would be one per chat and say nothing.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    const closed: [string, boolean][] = [];
    registry.onClosed((runId, interrupted) =>
      closed.push([runId, interrupted]),
    );

    registry.startTurn('run-working', adapter, INPUT, noop, undefined, noop);
    await at(sessions, 0).endTurn();
    at(sessions, 0).emitBetweenTurn('Bash-1');
    registry.close('run-working');

    registry.startTurn('run-quiet', adapter, INPUT, noop, undefined, noop);
    await at(sessions, 1).endTurn();
    registry.close('run-quiet');

    expect(closed).toEqual([
      ['run-working', true],
      ['run-quiet', false],
    ]);
  });

  it('drops a dead session rather than evicting a live one to make room for it', async () => {
    // The inverted consequence this fixes. A dead session reports `idle` false
    // — it is not "alive with no turn in flight" — so the eviction scan used to
    // skip it as though it were BUSY while still counting it against the
    // ceiling. The slot it occupied forever was paid for by a genuinely live
    // idle session being closed instead, respawning that run's CLI and
    // re-booting the user's MCP servers.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    for (let i = 0; i < CEILING; i += 1) {
      registry.startTurn(`run-${i}`, adapter, INPUT, noop);
      await at(sessions, i).endTurn();
      vi.advanceTimersByTime(1_000);
    }
    // The NEWEST session dies behind the registry's back, with its settle not
    // yet landed — so `closed` has not fired and only the eviction scan can
    // notice. It is also the least attractive eviction candidate by age, which
    // is what makes this discriminating.
    at(sessions, CEILING - 1).dieWithoutSettling();

    registry.startTurn('run-new', adapter, INPUT, noop);

    expect(at(sessions, CEILING - 1).closes).toBe(1);
    // The oldest LIVE session survived — under the old scan it was the one
    // that went.
    expect(at(sessions, 0).closes).toBe(0);
    expect(registry.liveCount).toBe(CEILING);
  });

  it('forgets a session the moment its process dies, without waiting to be asked', async () => {
    const registry = new AgentSessionRegistry(CEILING);
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
    const registry = new AgentSessionRegistry(CEILING);
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
    expect(registry.liveCount).toBe(CEILING);

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
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    for (let i = 0; i < CEILING; i += 1) {
      registry.startTurn(`run-${i}`, adapter, INPUT, noop); // all still busy
    }

    registry.startTurn('run-new', adapter, INPUT, noop);

    expect(sessions.every((s) => s.closes === 0)).toBe(true);
    expect(registry.liveCount).toBe(CEILING + 1);
  });
});

describe('AgentSessionRegistry — a folder whose MCP servers changed', () => {
  it('runs the next turn on a NEW process, not the one that read the old config', async () => {
    // THE REPORTED DEFECT: "usually when I update MCP they are available from
    // the very next turn; here it did not see they were updated". A CLI reads
    // its MCP configuration once, at spawn, and this registry keeps that
    // process across a chat's turns — so a server switched on or signed in to
    // reached the config and never reached the running agent. The agent said so
    // itself in the transcript: "the connector may need the session restarted".
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    const first = at(sessions, 0);
    await first.endTurn();

    expect(
      registry.markStale('claude', '/proj', 'its MCP servers changed'),
    ).toBe(1);
    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(sessions).toHaveLength(2);
    expect(first.closes).toBe(1);
  });

  it('marks rather than closes, so a running turn is never killed for it', async () => {
    // The whole reason this is a flag and not a `close`. A change can land
    // while a turn is in flight, and closing there destroys work the user
    // asked for — while a folder holding a dozen idle chats would cost a dozen
    // respawns, each re-launching the user's own MCP servers, for turns nobody
    // sent. The next turn is both the correct moment and the only one that
    // costs anything.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);

    registry.markStale('claude', '/proj', 'its MCP servers changed');

    expect(at(sessions, 0).closes).toBe(0);
    expect(registry.liveCount).toBe(1);
  });

  it('leaves another folder’s sessions alone', async () => {
    // A change is about ONE folder: a CLI resolves project servers relative to
    // the directory it runs in, so retiring every session would respawn chats
    // whose configuration did not move.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();

    expect(registry.markStale('claude', '/somewhere-else', 'changed')).toBe(0);
    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(sessions).toHaveLength(1);
  });

  it('leaves another AGENT’s sessions alone in the same folder', async () => {
    // One folder is routinely used by both CLIs, and they read different
    // configuration files — the same rule `SkillHarvestStore` keys by.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();

    expect(registry.markStale('cursor-agent', '/proj', 'changed')).toBe(0);
    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(sessions).toHaveLength(1);
  });

  it('retires a session ONCE, however many changes land before its next turn', async () => {
    // Toggling three servers before typing is one respawn, not three — and the
    // count each caller logs must not claim sessions it did not newly retire.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();

    expect(registry.markStale('claude', '/proj', 'first')).toBe(1);
    expect(registry.markStale('claude', '/proj', 'second')).toBe(0);
    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(sessions).toHaveLength(2);
  });
});

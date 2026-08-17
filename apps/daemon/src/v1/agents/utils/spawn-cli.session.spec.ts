import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeSpawn } from '../__tests__/fake-child';
import type { AgentEvent, TurnIo } from '../adapters/adapter.types';
import { runCliSession, runHeadlessCli, type SessionLogger } from './spawn-cli';

const noopMapper = (): AgentEvent[] => [];

/** The turn's `result` line, mapped — the shape a real mapper produces. */
const COMPLETE: AgentEvent = {
  type: 'turn_complete',
  usage: null,
  stopReason: null,
  finalText: null,
};

/**
 * A mapper turning `{done:true}` into that terminal event and `{failed:true}`
 * into an error — the two shapes a real `result` line reduces to.
 */
const resultOnDone = (obj: unknown): AgentEvent[] => {
  const row = obj as {
    done?: boolean;
    failed?: boolean;
    tool?: string;
    work?: string;
    phase?: 'started' | 'settled';
    /** What the unit IS, when the line says — a delegate or anything else. */
    unit?: 'agent' | 'other';
    /** The call that launched it, as a delegate's `started` line carries. */
    call?: string;
    finalText?: string;
    ask?: string;
  };
  if (typeof row.work === 'string' && row.phase !== undefined) {
    return [
      {
        type: 'background_work',
        id: row.work,
        phase: row.phase,
        unit: row.unit ?? 'other',
        toolCallId: row.call ?? null,
      },
    ];
  }
  // A card the CLI is now blocked on, waiting for a verdict.
  if (typeof row.ask === 'string') {
    return [
      {
        type: 'approval_request',
        id: row.ask,
        toolName: 'AskUserQuestion',
        input: { questions: [] },
        requiresUserInteraction: true,
      },
    ];
  }
  if (row.done === true) {
    // A result line's own text, for the cases that care WHICH result was kept.
    return typeof row.finalText === 'string'
      ? [{ ...COMPLETE, finalText: row.finalText }]
      : [COMPLETE];
  }
  if (row.failed === true) {
    return [{ type: 'error', message: 'result: is_error' }];
  }
  // A non-terminal line, for the cases that care where mid-turn output lands.
  if (typeof row.tool === 'string') {
    return [
      {
        type: 'tool_result',
        id: row.tool,
        name: null,
        result: 'ok',
        isError: false,
      },
    ];
  }
  return [];
};

function openSession(
  child?: Parameters<typeof fakeSpawn>[0],
  logger?: SessionLogger,
  onBetweenTurnEvent?: (event: AgentEvent) => void,
) {
  const { spawn, child: c, captured } = fakeSpawn(child);
  const session = runCliSession({
    command: 'claude',
    args: [],
    cwd: '/proj',
    stdinLifetime: 'session',
    mapper: resultOnDone,
    spawn,
    logger,
    onBetweenTurnEvent,
  });
  return { session, child: c, captured };
}

/** Feed the child one NDJSON line. */
function line(
  child: { stdout: { emitData(chunk: string): void } },
  obj: unknown,
): void {
  child.stdout.emitData(`${JSON.stringify(obj)}\n`);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a run-scoped session outlives its turns', () => {
  it('serves a second turn on the SAME process, with stdin never closed', async () => {
    // This is the whole point of item 11, stated as a test. A CLI boots the
    // user's MCP servers when it starts, and an MCP server can own something
    // expensive — a browser the user is logged into. One process per turn
    // therefore tears that down on every message. One process per RUN boots it
    // once. The observable is the spawn count and the still-open stdin.
    const events: AgentEvent[] = [];
    const { session, child, captured } = openSession();

    const first = session.startTurn({
      stdinPayload: 'FIRST\n',
      onEvent: (e) => events.push(e),
    });
    expect(first).not.toBeNull();
    line(child, { done: true });
    await first?.done;

    // The turn is over…
    expect(events).toEqual([COMPLETE]);
    // …and the process is not.
    expect(child.stdin.ended).toBe(false);
    expect(child.kills).toBe(0);
    expect(session.alive).toBe(true);
    expect(session.idle).toBe(true);

    const second = session.startTurn({
      stdinPayload: 'SECOND\n',
      onEvent: (e) => events.push(e),
    });
    expect(second).not.toBeNull();
    expect(child.stdin.written).toBe('FIRST\nSECOND\n');
    // One spawn for two turns — asserted through the seam, not inferred.
    expect(captured.command).toBe('claude');
    line(child, { done: true });
    await second?.done;
    expect(child.kills).toBe(0);
  });

  it('stops serving a session whose stdin broke BETWEEN turns', async () => {
    // The gap a kept process opened: its pipe can break with no turn in
    // flight, and every exit from the stdin error handler was a bare `return`
    // — nothing marked, nothing recorded. The session then reported itself
    // idle AND alive forever, so the registry kept handing it out and each
    // later turn wrote into a pipe nobody was reading.
    const warnings: string[] = [];
    const { session, child } = openSession(undefined, {
      warn: (message: string) => warnings.push(message),
      info: () => {},
      error: () => {},
    } as unknown as SessionLogger);

    const first = session.startTurn({ onEvent: () => {} });
    line(child, { done: true });
    await first?.done;
    expect(session.idle).toBe(true);

    child.stdin.breakPipe();

    expect(session.idle).toBe(false);
    expect(session.startTurn({ onEvent: () => {} })).toBeNull();
    // It left THE REASON behind, not merely a note that something happened.
    // Asserting the generic word passed on `handleOrphanEvent`'s own "dropped
    // a 'error' event" line while the EPIPE text was being discarded — a pin
    // that certified the opposite of what it claimed.
    expect(warnings.join('\n')).toContain('stdin error');
    expect(warnings.join('\n')).toContain('EPIPE');
  });

  it('announces the END of a session whose stdin broke between turns, so its owner can drop it', async () => {
    // Marking the session unusable is only half of it. `AgentSessionRegistry`
    // forgets an entry through ONE channel — `CliSession.closed` — and it
    // treats a non-idle entry as BUSY: the idle timer skips it, `evictIfFull`
    // skips it while still counting it against MAX_LIVE_SESSIONS, and
    // `!alive` (its only other escape hatch) is false because the process is
    // still running. So a pipe that breaks between turns leaves a session that
    // can never serve another turn holding a slot for the daemon's lifetime,
    // and a genuinely healthy idle session is evicted in its place — the exact
    // inversion `forgetWhenClosed` was written to prevent.
    //
    // The handler already does the right thing when a turn is in flight
    // (`endProcess()`); the between-turns branch is the asymmetry.
    const { session, child } = openSession();

    const first = session.startTurn({ onEvent: () => {} });
    line(child, { done: true });
    await first?.done;

    let announced = false;
    void session.closed.then(() => {
      announced = true;
    });

    child.stdin.breakPipe();
    // A macrotask, so every pending microtask (the `closed` continuation
    // above) has already run — no timing to be lucky about.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(announced).toBe(true);
    expect(session.alive).toBe(false);
  });

  it('reports a write into a broken stdin as NOT delivered', async () => {
    // `sendUserMessage`'s answer decides whether the chat commits the user's
    // message to the transcript, so a true it cannot honour loses the message
    // silently. Writing past an ended pipe does not throw, so the old
    // try/catch answered true for a write that never landed.
    const { session, child } = openSession();
    const handle = session.startTurn({
      onEvent: () => {},
      buildFollowUpPayload: (message) => `${message.text}\n`,
    });

    expect(handle?.sendUserMessage({ text: 'lands', images: undefined })).toBe(
      true,
    );

    child.stdin.writable = false;

    expect(handle?.sendUserMessage({ text: 'lost', images: undefined })).toBe(
      false,
    );
    expect(child.stdin.written).not.toContain('lost');
  });

  it('settles a session turn on its terminal EVENT, not on the process dying', async () => {
    // A session turn whose `done` waited for the process would never resolve —
    // the process is meant to outlive it. Pinned by resolving `done` while the
    // child is demonstrably still running.
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: () => {} });

    line(child, { done: true });
    await handle?.done; // would hang forever if this waited on `close`

    expect(session.alive).toBe(true);
  });

  it('refuses a second turn while one is still in flight', () => {
    // One turn at a time per process: the CLI's stdout is a single stream and
    // two turns reading it would interleave into each other's transcripts.
    // Null (rather than a queue) is what lets the caller spawn a fresh process.
    const { session } = openSession();

    expect(session.startTurn({ onEvent: () => {} })).not.toBeNull();
    expect(session.idle).toBe(false);
    expect(session.startTurn({ onEvent: () => {} })).toBeNull();
  });

  it('refuses a turn once the process is gone', async () => {
    const { session, child } = openSession();

    child.emit('close', 0, null);
    await session.closed;

    expect(session.alive).toBe(false);
    expect(session.idle).toBe(false);
    expect(session.startTurn({ onEvent: () => {} })).toBeNull();
  });

  it('refuses a turn as soon as the process exits, without waiting out the settle grace', () => {
    // `close` is what settles, and on a run-scoped session it can lag `exit` by
    // the full grace window — MCP grandchildren hold the inherited stdio open.
    // For those two seconds nothing else has changed: `processGone` is false
    // and stdin was never ended, so the session used to report itself idle and
    // alive and hand the registry a handle on a process that had already gone.
    vi.useFakeTimers();
    const { session, child } = openSession();

    child.emit('exit', 0, null);

    expect(session.alive).toBe(false);
    expect(session.idle).toBe(false);
    expect(session.startTurn({ onEvent: () => {} })).toBeNull();
  });

  it('records a clean exit that produced no result as a failure, not a success', async () => {
    // The silence is the bug: with no terminal event, `ChatService` writes a
    // synthetic `turn_complete` and the transcript shows an answered turn that
    // has no answer in it.
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(2000);
    await handle?.done;

    expect(events).toEqual([
      { type: 'error', message: expect.stringContaining('without completing') },
    ]);
  });

  it('drops a stray event arriving between turns instead of giving it to the next one', async () => {
    // Trailing stdout after a turn's `result` belongs to the turn that ended.
    // Holding it for the next turn would file one turn's output under another;
    // the warning is what keeps the drop from being silent.
    const warn = vi.fn();
    const events: AgentEvent[] = [];
    const { session, child } = openSession(undefined, { warn });

    const first = session.startTurn({ onEvent: (e) => events.push(e) });
    line(child, { done: true });
    await first?.done;

    line(child, { done: true }); // arrives with no turn in flight

    const second = session.startTurn({ onEvent: (e) => events.push(e) });
    expect(events).toEqual([COMPLETE]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('between turns'));
    expect(second).not.toBeNull();
  });

  it('fails the turn in flight when the process is killed from outside', async () => {
    // A signal geniro never asked for. It used to settle `turn_cancelled` —
    // reading every signal as a Stop — which put a killed agent under the one
    // badge the app deliberately never notifies about, so a crashed turn ended
    // silently and blamed the user for stopping it.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    child.emit('close', null, 'SIGKILL');
    await handle?.done;

    expect(events).toEqual([
      { type: 'error', message: expect.stringContaining('SIGKILL') },
    ]);
    expect(session.alive).toBe(false);
  });

  it('still reads a kill it asked for as a cancellation', async () => {
    // The other half, and what keeps the fix above from turning every Stop into
    // a failure: `cancel()` is the path Stop and the shutdown reap both take,
    // and the SAME signal on that path is still the user's own doing.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    handle?.cancel();
    child.emit('close', null, 'SIGKILL');
    await handle?.done;

    expect(events).toEqual([{ type: 'turn_cancelled' }]);
  });

  it('reads a kill from closing the session as a cancellation too', async () => {
    // `close()` retires a session the daemon is done with — deliberate, so its
    // signal is not a failure either.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    session.close();
    child.emit('close', null, 'SIGTERM');
    await handle?.done;

    expect(events).toEqual([{ type: 'turn_cancelled' }]);
  });
});

describe('a session turn that goes silent', () => {
  it('gives up on the turn, and leaves the process alive to serve the next one', async () => {
    // The gap this closes: a `session` turn ends on its terminal EVENT, so a
    // process that stays alive and never emits one leaves the turn open with
    // nothing to bound it — both other backstops hang off `handle.done`, which
    // is precisely what never resolves here.
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const { session } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await handle?.done;

    expect(events).toEqual([
      { type: 'error', message: expect.stringContaining('giving up') },
    ]);
    // The process holds this run's MCP servers up. Only the turn was given up
    // on, so the next one still reuses it.
    expect(session.alive).toBe(true);
    expect(session.startTurn({ onEvent: () => {} })).not.toBeNull();
  });

  it('does not give up on a turn that is merely long', async () => {
    // Measured against SILENCE, not against the turn's length: an agent
    // legitimately works for hours, and a wall-clock cap would abandon real
    // work while the CLI was still reporting progress.
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
      // Deliberately a line this mapper makes NO event of: unrecognised
      // stdout is still the process talking, and settling over one would
      // present a vocabulary gap to the user as a hang.
      line(child, { note: i });
    }
    await vi.advanceTimersByTimeAsync(25 * 60 * 1000);

    // Two and a half hours in, still running.
    expect(events).toEqual([]);
    expect(handle).not.toBeNull();

    line(child, { done: true });
    await handle?.done;
    expect(events).toEqual([COMPLETE]);
  });
});

describe('a turn parked on a question nobody has answered yet', () => {
  /** A turn whose verdicts actually reach the child. */
  const startAnswerableTurn = (
    session: ReturnType<typeof openSession>['session'],
    events: AgentEvent[],
  ) =>
    session.startTurn({
      onEvent: (e) => events.push(e),
      buildApprovalResponse: (id, allow) =>
        `${JSON.stringify({ verdict: id, allow })}\n`,
    });

  it('is not given up on, however long the user takes', async () => {
    // The reported defect, measured on the user's own daemon log twice on
    // 2026-08-11: an AskUserQuestion card went up, the user stepped away, and
    // 30 minutes and one second later the turn was settled as `error` with
    // "produced nothing… giving up on the turn", the run marked failed and the
    // card the user was coming back to answer rewritten as `unanswerable`.
    //
    // Nothing arrived after the card because nothing COULD — the CLI was
    // blocked on a verdict geniro itself was withholding. This deadline exists
    // for UNEXPLAINED silence; here the silence is fully accounted for, so it
    // must not run at all.
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = startAnswerableTurn(session, events);

    line(child, { ask: 'card-1' });
    // Three hours away from the desk — six times the old deadline.
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);

    expect(events).toEqual([
      expect.objectContaining({ type: 'approval_request', id: 'card-1' }),
    ]);

    // …and the card is still answerable, which is the whole point: the user
    // comes back and the turn carries on.
    expect(handle?.respondApproval('card-1', true, undefined)).toBe(true);
    line(child, { done: true });
    await handle?.done;
    expect(events.at(-1)).toEqual(COMPLETE);
  });

  it('starts the clock again from the ANSWER, not from when the card went up', async () => {
    // Suspended, not lengthened. If the deadline had merely been rearmed when
    // the card was raised, an answer at minute 29 would leave the turn one
    // minute from being abandoned — the user answers and watches it fail
    // anyway. The window has to begin where the CLI's obligation to speak does.
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = startAnswerableTurn(session, events);

    line(child, { ask: 'card-1' });
    await vi.advanceTimersByTimeAsync(29 * 60 * 1000);
    expect(handle?.respondApproval('card-1', true, undefined)).toBe(true);

    // 58 minutes into the turn, 29 since the answer: still running.
    await vi.advanceTimersByTimeAsync(29 * 60 * 1000);
    expect(events.some((e) => e.type === 'error')).toBe(false);

    // …and the deadline is genuinely BACK, not disabled for good — a turn that
    // stays silent after its answer is still given up on.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    await handle?.done;
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: expect.stringContaining('giving up'),
    });
  });

  it('keeps waiting while a SECOND card is still unanswered', async () => {
    // Answering one of two does not unblock the CLI, so the clock must stay
    // suspended. Rearming on the first delivery would abandon the turn while a
    // card was still on screen — the same failure, one card later.
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = startAnswerableTurn(session, events);

    line(child, { ask: 'card-1' });
    line(child, { ask: 'card-2' });
    expect(handle?.respondApproval('card-1', true, undefined)).toBe(true);

    await vi.advanceTimersByTimeAsync(90 * 60 * 1000);
    expect(events.some((e) => e.type === 'error')).toBe(false);

    expect(handle?.respondApproval('card-2', true, undefined)).toBe(true);
    line(child, { done: true });
    await handle?.done;
    expect(events.at(-1)).toEqual(COMPLETE);
  });

  it('can still be stopped by the user while it waits', async () => {
    // With no deadline behind it, Stop is the ONLY way out of a parked turn —
    // so the escape hatch the suspension leans on is pinned here rather than
    // assumed.
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({
      onEvent: (e) => events.push(e),
      buildApprovalResponse: (id, allow) =>
        `${JSON.stringify({ verdict: id, allow })}\n`,
      buildInterruptPayload: () => 'INTERRUPT\n',
    });

    line(child, { ask: 'card-1' });
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

    handle?.cancel();
    // The CLI answers an interrupt with an errored result, which the cancel
    // normalizes.
    line(child, { failed: true });
    await handle?.done;

    expect(events.at(-1)).toEqual({ type: 'turn_cancelled' });
  });
});

describe('cancelling a session turn', () => {
  it('asks the CLI to stop in protocol and leaves the process group alive', async () => {
    // Killing the group is what takes the user's MCP servers — and through them
    // a browser they are driving — down with the turn. On a run-scoped session
    // that cost is unacceptable for an ordinary Stop, and unnecessary:
    // probe-verified on claude 2.1.223, a `control_request`/`interrupt` ended
    // the turn in 2ms with the process still running.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({
      onEvent: (e) => events.push(e),
      buildInterruptPayload: () => 'INTERRUPT\n',
    });

    handle?.cancel();

    expect(child.stdin.written).toBe('INTERRUPT\n');
    expect(child.kills).toBe(0);

    // The CLI answers an interrupt with an ERRORED result. The cancel
    // normalizes it, so the transcript records a deliberate stop rather than a
    // failure the user never caused — and the process is still not killed.
    line(child, { failed: true });
    await handle?.done;

    expect(events).toEqual([{ type: 'turn_cancelled' }]);
    expect(child.kills).toBe(0);
    expect(session.alive).toBe(true);
  });

  it('refuses the NEXT turn, because the cancelled one may still be talking', async () => {
    // The defect this pins: a stream-json line carries no turn id, so `emit`
    // can only ask which turn is open NOW. After a Stop the CLI keeps printing
    // the rest of the cancelled turn, and every one of those lines was read as
    // the next turn's output — a trailing `result` settled that turn the
    // instant it opened, so the user's next message got no answer at all.
    //
    // Refusing here is what the registry turns into "replace this session", and
    // it costs the process nothing: the assertions above still hold, so Stop
    // has not killed anyone's MCP servers.
    const { session, child } = openSession();
    const first = session.startTurn({
      onEvent: () => {},
      buildInterruptPayload: () => 'INTERRUPT\n',
    });

    first?.cancel();
    line(child, { failed: true });
    await first?.done;

    expect(session.startTurn({ onEvent: () => {} })).toBeNull();
    // Retired from REUSE only — the process is untouched and still reapable by
    // the idle window rather than by a kill.
    expect(child.kills).toBe(0);
    expect(session.alive).toBe(true);
  });

  it('sends the cancelled turn’s STRAGGLERS to the between-turn path, not to a turn', async () => {
    // The defect itself, rather than the guard that prevents it. Retiring the
    // session is only half the fix: the tail still arrives, and where it lands
    // is what the user saw — a terminal line settling their next message
    // instantly, and text rendering under a message sent after it. With no turn
    // open it must reach `onBetweenTurnEvent`, which is where the run persists
    // it as its own late row.
    const betweenTurns: AgentEvent[] = [];
    const { session, child } = openSession(undefined, undefined, (event) =>
      betweenTurns.push(event),
    );
    const first = session.startTurn({
      onEvent: () => {},
      buildInterruptPayload: () => 'INTERRUPT\n',
    });

    first?.cancel();
    line(child, { failed: true });
    await first?.done;

    // The CLI keeps talking after the settle — including a terminal line, the
    // one that used to end the next turn on arrival.
    line(child, { tool: 't1' });
    line(child, { done: true });

    expect(betweenTurns).toEqual([
      {
        type: 'tool_result',
        id: 't1',
        name: null,
        result: 'ok',
        isError: false,
      },
      COMPLETE,
    ]);
  });

  it('kills the group when the CLI has no interrupt to send', () => {
    // The honest fallback: a CLI that cannot be told to stop can only be
    // stopped. Reporting the cancel as delivered without doing anything would
    // leave the turn running with the user told it had stopped.
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: () => {} });

    handle?.cancel();

    expect(child.kills).toBe(1);
    expect(child.killSignal).toBe('SIGTERM');
  });

  it('escalates to killing the group when an accepted interrupt never ends the turn', () => {
    // The branch that keeps Stop truthful. An interrupt the CLI acknowledges
    // but never acts on would otherwise leave the turn running forever with no
    // second attempt — so the deadline exists, and it is worth a test that
    // actually enters it.
    vi.useFakeTimers();
    const { session, child } = openSession();
    const handle = session.startTurn({
      onEvent: () => {},
      buildInterruptPayload: () => 'INTERRUPT\n',
    });

    handle?.cancel();
    expect(child.kills).toBe(0);

    vi.advanceTimersByTime(5_000);

    expect(child.kills).toBe(1);
    expect(child.killSignal).toBe('SIGTERM');
  });

  it('does not let a second Stop skip the interrupt grace', () => {
    // Found by this test: the second press used to fall straight through to
    // the group kill, destroying the MCP servers immediately — the exact
    // outcome the in-protocol path exists to avoid, reachable by an impatient
    // double-click. A stop already under way is idempotent; its deadline is
    // what bounds it.
    vi.useFakeTimers();
    const { session, child } = openSession();
    const handle = session.startTurn({
      onEvent: () => {},
      buildInterruptPayload: () => 'INTERRUPT\n',
    });

    handle?.cancel();
    handle?.cancel();

    expect(child.stdin.written).toBe('INTERRUPT\n');
    expect(child.kills).toBe(0);

    // The deadline still fires once, and only once.
    vi.advanceTimersByTime(5_000);
    expect(child.kills).toBe(1);
  });

  it('keeps the SIGKILL escalation armed after the turn settles ahead of the process', async () => {
    // The escalation belongs to the PROCESS, not the turn. On a session the two
    // come apart: `close()` sends SIGTERM while a turn is running, the CLI
    // prints an errored result, and the turn settles — with the group still
    // alive. Disarming on the turn's settle (which is where the single-turn
    // code could safely do it) would leave a CLI that ignores SIGTERM running
    // forever, and the whole point of `close()` is that it ends.
    vi.useFakeTimers();
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: () => {} });

    session.close();
    expect(child.killSignal).toBe('SIGTERM');

    line(child, { done: true }); // the turn ends; the process does not
    await handle?.done;

    vi.advanceTimersByTime(2_000);
    expect(child.killSignal).toBe('SIGKILL');
  });

  it('closes the process group on close(), even with a turn in flight', async () => {
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: () => {} });

    session.close();
    expect(child.kills).toBe(1);
    expect(child.killSignal).toBe('SIGTERM');

    child.emit('close', null, 'SIGTERM');
    await handle?.done;
    await session.closed;
    expect(session.alive).toBe(false);
  });
});

describe('runHeadlessCli keeps the one-turn contract', () => {
  it('records a clean exit that produced no result as a failure here too', async () => {
    // `settleFromTermination` is SHARED — this façade serves the `payload` and
    // `turn` lifetimes, which is every cursor ACP turn, every non-`ask` claude
    // turn and the probes. The clean-exit branch was pinned only for a
    // `session` lifetime, so a false alarm on this far busier path would have
    // shipped unnoticed, as would its removal.
    const events: AgentEvent[] = [];
    const { spawn, child } = fakeSpawn();
    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      mapper: resultOnDone,
      onEvent: (event) => events.push(event),
      spawn,
    });

    // Exit 0, no signal, and no `result` line ever printed.
    child.emit('close', 0, null);
    await handle.done;

    expect(events).toEqual([
      { type: 'error', message: expect.stringContaining('without completing') },
    ]);
  });

  it('stays silent when the turn DID complete before the clean exit', async () => {
    // The other half, and what stops the branch above becoming a false alarm on
    // the ordinary path: a process that printed its result and then exited 0 has
    // completed, and must not also report a failure.
    const events: AgentEvent[] = [];
    const { spawn, child } = fakeSpawn();
    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      mapper: resultOnDone,
      onEvent: (event) => events.push(event),
      spawn,
    });

    child.stdout.emitData(`${JSON.stringify({ done: true })}\n`);
    child.emit('close', 0, null);
    await handle.done;

    expect(events).toEqual([COMPLETE]);
  });

  it('closes a kept-open stdin on the terminal event and settles on the process', async () => {
    // The façade every pre-session caller still uses. Two properties it must
    // not lose: stdin is ended when the turn ends (or a stream-json CLI waits
    // on it forever), and `done` waits for the PROCESS so stdout has drained.
    const { spawn, child } = fakeSpawn();
    let settled = false;
    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      keepStdinOpen: true,
      mapper: resultOnDone,
      onEvent: () => {},
      spawn,
    });
    void handle.done.then(() => {
      settled = true;
    });

    child.stdout.emitData(`${JSON.stringify({ done: true })}\n`);
    await Promise.resolve();

    expect(child.stdin.ended).toBe(true);
    // The terminal event alone must NOT settle this shape of turn.
    expect(settled).toBe(false);

    child.emit('close', 0, null);
    await handle.done;
    expect(settled).toBe(true);
  });

  it('ends stdin immediately when the turn was never given a dialogue', () => {
    const { spawn, child } = fakeSpawn();

    runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinPayload: 'PROMPT\n',
      mapper: noopMapper,
      onEvent: () => {},
      spawn,
    });

    expect(child.stdin.written).toBe('PROMPT\n');
    expect(child.stdin.ended).toBe(true);
  });
});

/**
 * The turn-end line is the end of what the agent was SAYING, never of what its
 * process is DOING.
 *
 * Probed on claude 2.1.231: a turn told to launch a delegate and not wait for it
 * printed its `result` while the delegate was still running, and the CLI then
 * ran a FURTHER turn of its own accord as the delegate reported
 * (`origin:{kind:"task-notification"}` on that turn's own result line). Settling
 * on the first `result` therefore ends geniro's turn in the middle of the work.
 *
 * The cost, measured across the author's own daemon log: 11 of 31 settles were
 * followed by off-turn work — up to 33 minutes and 997 events past the settle,
 * 227 whole assistant messages dropped for want of a turn to put them in, 430
 * permission requests answered with no card ever shown — while the run reported
 * `completed` and its delegates rendered as `stopped`.
 */
describe('a turn whose background work outlives its result', () => {
  it('holds the turn open while a unit of work has not reported', async () => {
    const events: AgentEvent[] = [];
    let settled = false;
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });
    void handle?.done.then(() => {
      settled = true;
    });

    line(child, { work: 'task-1', phase: 'started' });
    line(child, { done: true });
    await Promise.resolve();

    // The `result` line arrived and was HELD: no terminal event, no settle, and
    // the run therefore never reads `completed` while the work is out.
    expect(events).toEqual([]);
    expect(settled).toBe(false);
    expect(session.idle).toBe(false);

    // …and the delegate's own output still has a turn to land in, which is the
    // whole reason to hold it open rather than merely relabel the badge.
    line(child, { tool: 'toolu_late' });
    expect(events).toEqual([
      {
        type: 'tool_result',
        id: 'toolu_late',
        name: null,
        result: 'ok',
        isError: false,
      },
    ]);

    line(child, { work: 'task-1', phase: 'settled' });
    await handle?.done;

    expect(events.at(-1)).toEqual(COMPLETE);
    expect(settled).toBe(true);
  });

  it('waits for the LAST unit, not the first to report', async () => {
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { work: 'task-1', phase: 'started' });
    line(child, { work: 'task-2', phase: 'started' });
    line(child, { done: true });
    line(child, { work: 'task-1', phase: 'settled' });
    await Promise.resolve();

    expect(events).toEqual([]);

    line(child, { work: 'task-2', phase: 'settled' });
    await handle?.done;
    expect(events).toEqual([COMPLETE]);
  });

  it('is not released by a report for work it never opened', async () => {
    // The set is keyed by the CLI's own id precisely so this cannot happen: a
    // stray or duplicated `settled` must not stand in for the one still out.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { work: 'task-1', phase: 'started' });
    line(child, { done: true });
    line(child, { work: 'somebody-elses-task', phase: 'settled' });
    await Promise.resolve();

    // Still held — the stray report closed nothing this turn was waiting on.
    expect(events).toEqual([]);

    line(child, { work: 'task-1', phase: 'settled' });
    // A second report for the same task must not release a second terminal.
    line(child, { work: 'task-1', phase: 'settled' });
    await handle?.done;

    expect(events).toEqual([COMPLETE]);
  });

  it('keeps the FIRST result, which is the one that answers the prompt', async () => {
    // claude's later self-initiated turns print their own result lines, whose
    // text is a "Background note (no action needed)…" and whose usage is that
    // turn's, not this one's. Held means held: the answer the user asked for.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { work: 'task-1', phase: 'started' });
    line(child, { done: true, finalText: 'LAUNCHED' });
    line(child, {
      done: true,
      finalText: 'Background note (no action needed)',
    });
    await Promise.resolve();

    // Neither result ended the turn — the second one least of all.
    expect(events).toEqual([]);

    line(child, { work: 'task-1', phase: 'settled' });
    await handle?.done;

    expect(events).toEqual([{ ...COMPLETE, finalText: 'LAUNCHED' }]);
  });

  it('announces a DELEGATE’s background lifecycle, keyed by its launching call', async () => {
    // The one thing forwarded off this channel, and the reason it must be: a
    // delegate the agent does not wait for has its `Task` call answered at once,
    // so the transcript reads it as finished while it runs on. These two rows
    // are what let the block — and the header's counter — say otherwise.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, {
      work: 'task-1',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_a',
    });
    // The settle names neither the kind nor the call — matched by work id.
    line(child, { work: 'task-1', phase: 'settled' });
    line(child, { done: true });
    await handle?.done;

    expect(events).toEqual([
      {
        type: 'subagent_info',
        id: 'toolu_a',
        label: null,
        kind: null,
        prompt: null,
        model: null,
        durationMs: null,
        stepsUnavailableReason: null,
        backgroundOpen: true,
      },
      {
        type: 'subagent_info',
        id: 'toolu_a',
        label: null,
        kind: null,
        prompt: null,
        model: null,
        durationMs: null,
        stepsUnavailableReason: null,
        backgroundOpen: false,
      },
      COMPLETE,
    ]);
  });

  it('says nothing about background work that is not a delegate', async () => {
    // The same channel carries a delegate's own shell command. Announcing one
    // would put a phantom sub-agent in the transcript, under the id of whatever
    // tool call happened to launch it.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, {
      work: 'task-bash',
      phase: 'started',
      unit: 'other',
      call: 'toolu_bash',
    });
    line(child, { work: 'task-bash', phase: 'settled', call: 'toolu_bash' });
    line(child, { done: true });
    await handle?.done;

    expect(events).toEqual([COMPLETE]);
  });

  it('never hands a background_work event to the turn', async () => {
    // Turn plumbing, not conversation. `mapEventToItem` answers null for it too,
    // but a consumer must not see it at all — a pair of "work started/settled"
    // rows would say what the delegate's own rows already say.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { work: 'task-1', phase: 'started' });
    line(child, { work: 'task-1', phase: 'settled' });
    line(child, { done: true });
    await handle?.done;

    expect(events).toEqual([COMPLETE]);
  });

  it('does NOT hold a cancel or a failure back', async () => {
    // A cancel is the user asking to stop now, and an `error` is a turn that
    // failed rather than finished. Holding either would keep a turn open for
    // work the user just abandoned, or hide a failure behind a delegate.
    const cancelled: AgentEvent[] = [];
    const first = openSession();
    const cancelHandle = first.session.startTurn({
      onEvent: (e) => cancelled.push(e),
      buildInterruptPayload: () => 'INTERRUPT\n',
    });
    line(first.child, { work: 'task-1', phase: 'started' });
    cancelHandle?.cancel();
    line(first.child, { failed: true });
    await cancelHandle?.done;
    expect(cancelled).toEqual([{ type: 'turn_cancelled' }]);

    const failed: AgentEvent[] = [];
    const second = openSession();
    const failHandle = second.session.startTurn({
      onEvent: (e) => failed.push(e),
    });
    line(second.child, { work: 'task-2', phase: 'started' });
    line(second.child, { failed: true });
    await failHandle?.done;
    expect(failed).toEqual([{ type: 'error', message: 'result: is_error' }]);
  });

  it('releases the held result when the process exits cleanly under it', async () => {
    // The work is over one way or another once the process is gone, and the turn
    // DID complete. Falling through to the clean-exit branch would replace a real
    // `turn_complete` with "exited without completing the turn".
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { work: 'task-1', phase: 'started' });
    line(child, { done: true });
    child.emit('close', 0, null);
    await handle?.done;

    expect(events).toEqual([COMPLETE]);
    expect(session.alive).toBe(false);
  });

  it('releases the held result when the work goes silent too', async () => {
    // The bound, and it is the turn's existing silence deadline rather than a
    // second timer. Its own sentence ("produced nothing… giving up") would be
    // false twice over about this turn — it produced an answer, and what went
    // quiet was the work — so the held result is what gets released.
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = openSession(undefined, logger);
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { work: 'task-1', phase: 'started' });
    line(child, { done: true });
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await handle?.done;

    expect(events).toEqual([COMPLETE]);
    expect(logger.warn.mock.calls.map(String).join('\n')).toContain(
      'never reported',
    );
    // And the process is left alive for the next turn, as every other
    // silence-deadline settle leaves it.
    expect(session.alive).toBe(true);
  });

  it('does not defer on a lifetime whose turn ends with its process', async () => {
    // A one-turn CLI's delegates die with the process, so there is no "after" to
    // wait for — deferring would hold the turn open for work that is over.
    const events: AgentEvent[] = [];
    const { spawn, child } = fakeSpawn();
    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      keepStdinOpen: true,
      mapper: resultOnDone,
      onEvent: (event) => events.push(event),
      spawn,
    });

    child.stdout.emitData(
      `${JSON.stringify({ work: 'task-1', phase: 'started' })}\n`,
    );
    child.stdout.emitData(`${JSON.stringify({ done: true })}\n`);
    await Promise.resolve();

    // Emitted at once — and stdin closed with it, which is what asks a
    // stream-json CLI to finish at all.
    expect(events).toEqual([COMPLETE]);
    expect(child.stdin.ended).toBe(true);
    child.emit('close', 0, null);
    await handle.done;
  });
});

/**
 * The D1 state: the process outlives the turn geniro was tracking and keeps
 * working. Measured across the author's own `geniro.db` — 1589 of 4505 tool
 * results arrived with no turn in flight, carrying 165 of the 181
 * `Tool permission request failed: ... Stream closed` failures (10.4% against
 * 0.5% inside an open turn).
 */
describe('an event arriving between turns', () => {
  /** `{ask:<id>}` becomes a permission request; `{done:true}` ends the turn. */
  const askOrDone = (obj: unknown): AgentEvent[] => {
    const row = obj as { done?: boolean; ask?: string };
    if (row.done === true) {
      return [COMPLETE];
    }
    if (typeof row.ask === 'string') {
      return [
        { type: 'approval_request', id: row.ask, toolName: 'Edit', input: {} },
      ];
    }
    return [];
  };

  /** As `askOrDone`, but the request is the CLI's question tool. */
  const questionOrDone = (obj: unknown): AgentEvent[] => {
    const row = obj as { done?: boolean; ask?: string };
    if (row.done === true) {
      return [COMPLETE];
    }
    if (typeof row.ask === 'string') {
      return [
        {
          type: 'approval_request',
          id: row.ask,
          toolName: 'AskUserQuestion',
          input: {},
        },
      ];
    }
    return [];
  };

  // `questionToolName` is declared on every session here even though this
  // mapper emits a PERMISSION tool: that is what makes the refusal tests below
  // prove a discrimination rather than the absence of one. Without it they
  // would pass just as well if the question branch swallowed everything.
  function sessionAskingAfterSettle(
    logger: SessionLogger,
    mapper: (obj: unknown) => AgentEvent[] = askOrDone,
  ) {
    const { spawn, child } = fakeSpawn();
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper,
      spawn,
      logger,
      questionToolName: 'AskUserQuestion',
    });
    return { session, child };
  }

  it('leaves an orphaned QUESTION unanswered instead of denying it in the user’s name', async () => {
    // The refusal beside this encodes `allow: false`, which reaches claude as
    // `{behavior:'deny', message:'Denied by the user in Geniro'}`. An
    // AskUserQuestion rides the SAME `approval_request` channel, so refusing it
    // answers the user's question for them, over their name, and they never see
    // it was asked. Parked it merely stalls — which is the honest state, and
    // what it did before the refusal existed.
    //
    // Keyed on the tool NAME the adapter declares, never on a payload flag: a
    // future interactive tool must not be able to slip past a human gate
    // through version drift.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger, questionOrDone);

    const turn = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await turn?.done;
    const writtenBefore = child.stdin.written;

    line(child, { ask: 'q-1' });

    // Nothing at all on stdin — not a denial, not anything.
    expect(child.stdin.written.slice(writtenBefore.length)).toBe('');
    expect(logger.warn.mock.calls.map(String).join('\n')).toContain(
      'held for the next turn to adopt',
    );
    expect(session.alive).toBe(true);
  });

  it('refuses an orphaned permission when the owner supplies NO posture (the default)', async () => {
    // The fallback for a caller with nothing to say about posture — not what
    // the chat service does, which supplies one. It exists because dropping is
    // not neutral: the CLI is blocked on a verdict that, with no turn, nothing
    // will ever send, and a caller that cannot say "allow" at least unblocks
    // it. An owner WITH a posture takes the paths below instead, where a
    // refusal in the user's name is precisely what is avoided.
    // The observable is the verdict ON STDIN.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger);

    const turn = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await turn?.done;
    const writtenBefore = child.stdin.written;

    // The process is still alive and now asks about work no turn owns.
    line(child, { ask: 'req-1' });

    expect(child.stdin.written.slice(writtenBefore.length)).toBe(
      'VERDICT req-1 false\n',
    );
    expect(session.alive).toBe(true);
  });

  it('hands the NEXT turn the held question ITSELF, ahead of the notice, once', async () => {
    // A turn owns `onEvent`, so at the moment the question arrived there was
    // nothing to show it to and it lived only in the daemon log. Replaying the
    // request into the next turn is what gives it a destination at all: it
    // arrives as an ordinary `approval_request` and takes the same card path
    // every in-turn request takes, so the user finally sees what was asked and
    // their verdict reaches a live stdin.
    //
    // Order matters and is asserted, not incidental: the notice says the
    // request is shown above, so a card arriving after its own explanation
    // would make a liar of it.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger, questionOrDone);

    const first = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await first?.done;

    line(child, { ask: 'q-1' });

    const events: AgentEvent[] = [];
    const second = session.startTurn({
      onEvent: (event) => events.push(event),
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'approval_request',
        id: 'q-1',
        toolName: 'AskUserQuestion',
      }),
      expect.objectContaining({
        type: 'notice',
        message: expect.stringContaining('between turns'),
        // INFORMATION, not an advisory: the request was kept and handed over
        // exactly as designed. Without this the row renders in the daemon's
        // failure chrome, which got it reported as an error.
        severity: 'info',
      }),
    ]);

    // Drained, not copied — once ANSWERED, no later turn repeats it. (An
    // adopted request the turn never answers is deliberately re-held instead;
    // that is its own case below.)
    second?.respondApproval('q-1', true, undefined);
    line(child, { done: true });
    await second?.done;
    const later: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => later.push(event) });
    expect(later).toEqual([]);
  });

  it('re-holds an adopted request the turn settles without answering', async () => {
    // Adoption empties the hold buffer, so a turn that ends before the user
    // answers the card would otherwise drop the request for good — the CLI
    // stays blocked, the notice is spent, and the chat goes quiet again. That
    // is the same wedge, one turn later.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger, questionOrDone);

    const first = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await first?.done;

    line(child, { ask: 'q-1' });

    // Turn 2 is shown the card and then ends with no verdict.
    const second = session.startTurn({ onEvent: () => {} });
    line(child, { done: true });
    await second?.done;

    // Turn 3 is offered it again, rather than inheriting a silently blocked CLI.
    const third: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => third.push(event) });
    expect(third[0]).toEqual(
      expect.objectContaining({ type: 'approval_request', id: 'q-1' }),
    );
  });

  it('re-holds a request raised INSIDE a turn that then ended without answering it', async () => {
    // Same wedge, reached through the commoner door. A request the CLI raises
    // while a turn IS open is delivered to that turn and never enters the hold
    // buffer, so `adopted` — which only ever records what a turn ADOPTED — has
    // nothing to give back when the turn settles unanswered.
    //
    // The turn here ends on its own `result` line with the card still open —
    // a sub-agent's question outliving the turn that launched it — and the
    // process is deliberately kept for the next turn: so that turn inherits a
    // CLI still parked on this question, with the request now unreachable from
    // anywhere. The buffer already knows it is outstanding — `approvalSeenAt`
    // holds it right up to the `clear()` on settle — so the information to
    // re-hold it exists and is thrown away.
    //
    // It used to reach that settle through the silence deadline instead, which
    // no longer runs while a card is open (see `TURN_SILENCE_DEADLINE_MS`):
    // waiting on a user is not a wedged CLI. The re-hold this pins is unchanged
    // — only the route into the unanswered settle had to move to one that still
    // exists.
    vi.useFakeTimers();
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger, questionOrDone);

    const first = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { ask: 'q-1' });
    // Nothing answers it, and the turn finishes anyway — the process is kept.
    line(child, { done: true });
    await first?.done;
    expect(session.alive).toBe(true);

    const second: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => second.push(event) });

    expect(second).toContainEqual(
      expect.objectContaining({ type: 'approval_request', id: 'q-1' }),
    );
  });

  it('does NOT re-hold a request the turn actually answered', async () => {
    // The other side of the same ledger: re-offering an answered request would
    // show the user a card for a decision they already made, and hand the CLI
    // a second verdict for one request.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger, questionOrDone);

    const first = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await first?.done;

    line(child, { ask: 'q-1' });

    const second = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    second?.respondApproval('q-1', true, undefined);
    line(child, { done: true });
    await second?.done;

    const third: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => third.push(event) });
    expect(third).toEqual([]);
  });

  it('answers a between-turn permission with the run’s posture instead of refusing it', async () => {
    // The bug this pins: under the `auto` chip every tool call arriving a
    // moment after its turn settled was refused, and the refusal reached the
    // agent as `{behavior:'deny', message:'Denied by the user in Geniro'}` for
    // a card that was never rendered. The user watched their agent report it
    // had lost write access to a worktree they had granted it.
    //
    // The observable is the verdict ON STDIN, and it must be the ALLOW the
    // posture calls for — asserting merely that something was written would
    // pass just as well with the deny restored.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { spawn, child } = fakeSpawn();
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: askOrDone,
      spawn,
      logger,
      questionToolName: 'AskUserQuestion',
      betweenTurnApproval: ({ toolName }) =>
        toolName === 'AskUserQuestion' ? null : true,
    });

    const turn = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await turn?.done;
    const writtenBefore = child.stdin.written;

    line(child, { ask: 'req-1' });

    expect(child.stdin.written.slice(writtenBefore.length)).toBe(
      'VERDICT req-1 true\n',
    );
    // Answered outright, so there is nothing left for a later turn to adopt.
    const later: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => later.push(event) });
    expect(later).toEqual([]);
  });

  it('hands a non-approval between-turn event to the owner instead of dropping it', async () => {
    // A `tool_result` arriving after its turn settled used to be dropped, so
    // the call it answers stayed unpaired on the transcript forever. The owner
    // files it under the RUN — the events are turn-less, not run-less.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { spawn, child } = fakeSpawn();
    const seen: AgentEvent[] = [];
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: (obj) => {
        const row = obj as { done?: boolean; result?: string };
        if (row.done === true) {
          return [COMPLETE];
        }
        return row.result === undefined
          ? []
          : [
              {
                type: 'tool_result',
                id: row.result,
                name: 'Bash',
                result: 'ok',
                isError: false,
              },
            ];
      },
      spawn,
      logger,
      onBetweenTurnEvent: (event) => seen.push(event),
    });

    const turn = session.startTurn({ onEvent: () => {} });
    line(child, { done: true });
    await turn?.done;

    line(child, { result: 't1' });

    expect(seen).toEqual([
      expect.objectContaining({ type: 'tool_result', id: 't1' }),
    ]);
    // Handed over, NOT buffered — replaying it into the next turn would file
    // one turn's output under another's.
    const next: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => next.push(event) });
    expect(next).toEqual([]);
  });

  it('bounds the hold buffer, and says which request it gave up on', async () => {
    // Nothing else bounds this: a CLI asking repeatedly on a chat nobody
    // returns to would hold one blocked tool call per request for the whole
    // 30-minute session life. Dropping the oldest is the concession; doing it
    // SILENTLY is not, because a dropped hold leaves a CLI blocked forever and
    // the log line is the only trace of why.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger, questionOrDone);

    const first = session.startTurn({ onEvent: () => {} });
    line(child, { done: true });
    await first?.done;

    // One past the cap of 20.
    for (let i = 0; i < 21; i += 1) {
      line(child, { ask: `q-${i}` });
    }

    const events: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => events.push(event) });
    const adopted = events.filter((event) => event.type === 'approval_request');
    expect(adopted).toHaveLength(20);
    // The OLDEST went, not the newest.
    expect(adopted.map((event) => (event as { id: string }).id)).not.toContain(
      'q-0',
    );
    expect(logger.warn.mock.calls.map(String).join('\n')).toContain(
      'dropped held request',
    );
  });

  it('says the between-turns thing ONCE however many requests are held', async () => {
    // The notice explains a state, not each occurrence. Twenty verbatim copies
    // of one sentence would bury the twenty cards it is pointing at.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger, questionOrDone);

    const first = session.startTurn({ onEvent: () => {} });
    line(child, { done: true });
    await first?.done;

    line(child, { ask: 'q-1' });
    line(child, { ask: 'q-2' });
    line(child, { ask: 'q-3' });

    const events: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => events.push(event) });
    expect(events.filter((event) => event.type === 'notice')).toHaveLength(1);
    expect(
      events.filter((event) => event.type === 'approval_request'),
    ).toHaveLength(3);
  });

  it('will not let an owner posture auto-ANSWER the question tool', async () => {
    // A floor the owner cannot lower. Today's only policy discriminates
    // correctly, so this guards the next one: answering an AskUserQuestion
    // from a posture speaks for the user, in their name, about something they
    // never saw — the one outcome the whole between-turn seam refuses. The
    // previous code could not get this wrong because it refused every question
    // unconditionally; now that an owner decides, the floor has to be explicit.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { spawn, child } = fakeSpawn();
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: questionOrDone,
      spawn,
      logger,
      questionToolName: 'AskUserQuestion',
      // A careless policy: says "approve" for everything, questions included.
      betweenTurnApproval: () => true,
    });

    const turn = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await turn?.done;
    const writtenBefore = child.stdin.written;

    line(child, { ask: 'q-1' });

    // Nothing answered on the user's behalf…
    expect(child.stdin.written.slice(writtenBefore.length)).toBe('');
    // …and it is held for them instead.
    const events: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => events.push(event) });
    expect(events[0]).toEqual(
      expect.objectContaining({ type: 'approval_request', id: 'q-1' }),
    );
  });

  it('holds a between-turn permission the posture will not decide, rather than denying it', async () => {
    // The other half of the same policy: an `ask` chat has no standing answer,
    // so the request must reach a card — never a refusal in the user's name.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { spawn, child } = fakeSpawn();
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: askOrDone,
      spawn,
      logger,
      questionToolName: 'AskUserQuestion',
      betweenTurnApproval: () => null,
    });

    const turn = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await turn?.done;
    const writtenBefore = child.stdin.written;

    line(child, { ask: 'req-2' });

    expect(child.stdin.written.slice(writtenBefore.length)).toBe('');
    const events: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => events.push(event) });
    expect(events[0]).toEqual(
      expect.objectContaining({ type: 'approval_request', id: 'req-2' }),
    );
  });

  it('raises a between-turn question for the user NOW rather than holding it for a turn that may never come', async () => {
    // The incident: claude asked eight minutes after its turn had settled, the
    // request was held, and nothing said so — the transcript grew the tool row
    // and the badge went on reading "working" while the CLI stood blocked on a
    // person with no control to answer with. An owner that HAS a card surface
    // is offered the request instead, and the verdict it sends needs no turn:
    // the stdin and the encoder both outlive one.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { spawn, child } = fakeSpawn();
    const raised: string[] = [];
    let answer: ((allow: boolean, input?: unknown) => boolean) | null = null;
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: questionOrDone,
      spawn,
      logger,
      questionToolName: 'AskUserQuestion',
      betweenTurnApproval: () => null,
      onHeldApproval: (event, respond) => {
        raised.push(event.id);
        answer = respond;
        return true;
      },
    });

    const turn = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await turn?.done;
    const writtenBefore = child.stdin.written;

    line(child, { ask: 'q-1' });

    expect(raised).toEqual(['q-1']);
    // Still nothing answered on the user's behalf — the card is up, not filled.
    expect(child.stdin.written.slice(writtenBefore.length)).toBe('');
    // And the process is not "unused": it is standing still on a person.
    expect(session.parked).toBe(true);

    // Their verdict reaches the live stdin with no turn in flight at all.
    expect(answer!(true)).toBe(true);
    expect(child.stdin.written.slice(writtenBefore.length)).toBe(
      'VERDICT q-1 true\n',
    );
    expect(session.parked).toBe(false);

    // …and it is NOT also replayed into the next turn, which would draw the
    // user a second card for a question they have already answered.
    const events: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => events.push(event) });
    expect(
      events.filter((event) => event.type === 'approval_request'),
    ).toHaveLength(0);
  });

  it('falls back to holding when the owner will not take the request', async () => {
    // A caller with nowhere to draw a card must lose nothing — only wait
    // longer. The claim is the owner's to decline, so declining puts the
    // request back on the path it was always on.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { spawn, child } = fakeSpawn();
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: questionOrDone,
      spawn,
      logger,
      questionToolName: 'AskUserQuestion',
      onHeldApproval: () => false,
    });

    const turn = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await turn?.done;

    line(child, { ask: 'q-9' });

    expect(session.parked).toBe(true);
    const events: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => events.push(event) });
    expect(events[0]).toEqual(
      expect.objectContaining({ type: 'approval_request', id: 'q-9' }),
    );
  });

  it('names the tool and the request id, so the line can be joined to a transcript row', () => {
    // The message this replaces said only `dropped a 'approval_request' event
    // arriving between turns` — no tool, no id, no way to correlate it with
    // anything. That gap is why the 239 real occurrences had to be found by SQL.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger);
    const turn = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    void turn?.done;
    logger.warn.mockClear();

    line(child, { ask: 'req-7' });

    const message = logger.warn.mock.calls.map(String).join('\n');
    expect(message).toContain('Edit');
    expect(message).toContain('req-7');
    expect(message).toContain('refused');
  });

  it('says so when it CANNOT refuse — the CLI is then genuinely parked', () => {
    // A turn whose CLI has no approval protocol leaves no encoder behind, so
    // there is nothing to answer with. That is worth a different sentence: the
    // silent version of this is a wedged agent with no trace of why.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger);
    const turn = session.startTurn({ onEvent: () => {} }); // no encoder
    line(child, { done: true });
    void turn?.done;
    logger.warn.mockClear();

    line(child, { ask: 'req-9' });

    expect(logger.warn.mock.calls.map(String).join('\n')).toContain(
      'could NOT be answered',
    );
    expect(child.stdin.written).toBe('');
  });

  it('still merely DROPS a non-approval event — one turn must not inherit another turn output', () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { spawn, child } = fakeSpawn();
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: (obj) => {
        const row = obj as { done?: boolean; text?: string };
        if (row.done === true) {
          return [COMPLETE];
        }
        return row.text === undefined
          ? []
          : [{ type: 'text_delta', text: row.text }];
      },
      spawn,
      logger,
    });
    const turn = session.startTurn({ onEvent: () => {} });
    line(child, { done: true });
    void turn?.done;
    logger.warn.mockClear();

    line(child, { text: 'stray' });

    expect(logger.warn.mock.calls.map(String).join('\n')).toContain(
      "dropped a 'text_delta' event",
    );
    expect(child.stdin.written).toBe('');
  });
});

describe('the account the transport keeps of itself', () => {
  it('records a DELIVERED verdict, not only the failures', async () => {
    // Recording only failures is what made the D1 ratio unobtainable from logs:
    // "how often is a verdict actually delivered" has no answer unless the
    // delivered ones are written down too.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { spawn, child } = fakeSpawn();
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: (obj) => {
        const row = obj as { done?: boolean; ask?: string };
        if (row.done === true) {
          return [COMPLETE];
        }
        return typeof row.ask === 'string'
          ? [
              {
                type: 'approval_request',
                id: row.ask,
                toolName: 'Bash',
                input: {},
              },
            ]
          : [];
      },
      spawn,
      logger,
    });
    const turn = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { ask: 'req-2' });

    expect(turn?.respondApproval('req-2', true, {})).toBe(true);

    const debugged = logger.debug.mock.calls.map(String).join('\n');
    expect(debugged).toContain('req-2');
    expect(debugged).toContain('allowed');
    expect(debugged).toContain('written to stdin');
    // …and the round-trip is timed against when the request was RAISED.
    expect(debugged).toMatch(/\d+ms after it was raised/);
    line(child, { done: true });
    await turn?.done;
  });

  it('names WHY a turn settled, which no record carried before', async () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = openSession(undefined, logger);
    const turn = session.startTurn({ onEvent: () => {} });
    line(child, { done: true });
    await turn?.done;

    const debugged = logger.debug.mock.calls.map(String).join('\n');
    expect(debugged).toContain('turn opened');
    expect(debugged).toContain("turn settled (terminal event 'turn_complete')");
  });
});

describe('a turn whose prompt is held back until the CLI is ready', () => {
  /** A gate the spec opens and closes by hand. */
  function heldGate() {
    let release!: () => void;
    let reject!: (err: Error) => void;
    const opened = new Promise<void>((resolve, fail) => {
      release = resolve;
      reject = fail;
    });
    const seen: TurnIo[] = [];
    return {
      release,
      reject,
      seen,
      holdPrompt: (io: TurnIo) => {
        seen.push(io);
        return opened;
      },
    };
  }

  it('writes nothing until the gate resolves, then writes the prompt', async () => {
    // The defect this seam exists for, at the transport level: claude accepts a
    // prompt seconds before its MCP servers finish dialling, and answers it
    // with a tool surface those servers are missing from. Holding the prompt is
    // the fix, so the observable is that stdin stays EMPTY across the hold.
    const gate = heldGate();
    const { session, child } = openSession();

    const handle = session.startTurn({
      stdinPayload: 'PROMPT\n',
      holdPrompt: gate.holdPrompt,
      onEvent: () => {},
    });
    expect(handle).not.toBeNull();
    // The turn is open — its stdout is already being parsed, which is what lets
    // the gate hold a dialogue of its own — and nothing has been sent.
    expect(child.stdin.written).toBe('');

    gate.release();
    await Promise.resolve();
    await Promise.resolve();

    expect(child.stdin.written).toBe('PROMPT\n');
    line(child, { done: true });
    await handle?.done;
  });

  it('gives the gate a channel of its own, on the same still-open stdin', async () => {
    // The gate's poll and the prompt travel one pipe, so `write` has to be the
    // turn's real one — a gate handed a dead channel could never ask anything.
    const gate = heldGate();
    const { session, child } = openSession();

    const handle = session.startTurn({
      stdinPayload: 'PROMPT\n',
      holdPrompt: gate.holdPrompt,
      onEvent: () => {},
    });
    expect(gate.seen).toHaveLength(1);
    expect(gate.seen[0]?.write('POLL\n')).toBe(true);
    expect(child.stdin.written).toBe('POLL\n');

    gate.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(child.stdin.written).toBe('POLL\nPROMPT\n');
    line(child, { done: true });
    await handle?.done;
  });

  it('DROPS the prompt when the user cancels during the hold', async () => {
    // Waiting made a window that did not exist before: the user can now stop a
    // turn whose prompt has not been sent. Writing it afterwards would run work
    // they had already called off, in a turn that is already reported cancelled.
    const gate = heldGate();
    const events: AgentEvent[] = [];
    const { session, child } = openSession();

    const handle = session.startTurn({
      stdinPayload: 'PROMPT\n',
      holdPrompt: gate.holdPrompt,
      buildInterruptPayload: () => 'INTERRUPT\n',
      onEvent: (e) => events.push(e),
    });
    handle?.cancel();
    line(child, { failed: true });
    await handle?.done;

    gate.release();
    await Promise.resolve();
    await Promise.resolve();

    expect(child.stdin.written).not.toContain('PROMPT');
    expect(events).toEqual([{ type: 'turn_cancelled' }]);
  });

  it('sends the prompt anyway when the gate itself fails', async () => {
    // A gate is an optimisation over a turn that used to work. Losing the
    // user's message because a readiness poll threw would be a far worse
    // failure than the one it is fixing.
    const gate = heldGate();
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = openSession(undefined, logger);

    const handle = session.startTurn({
      stdinPayload: 'PROMPT\n',
      holdPrompt: gate.holdPrompt,
      onEvent: () => {},
    });
    gate.reject(new Error('poll exploded'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(child.stdin.written).toBe('PROMPT\n');
    expect(logger.warn.mock.calls.map(String).join('\n')).toContain(
      'poll exploded',
    );
    line(child, { done: true });
    await handle?.done;
  });

  it('keeps the opening write synchronous for a turn with no gate', async () => {
    // Every existing caller — cursor's ACP handshake included — depends on the
    // payload being on stdin before `startTurn` returns.
    const { session, child } = openSession();

    const handle = session.startTurn({
      stdinPayload: 'PROMPT\n',
      onEvent: () => {},
    });

    expect(child.stdin.written).toBe('PROMPT\n');
    line(child, { done: true });
    await handle?.done;
  });

  it('opens a client-initiated protocol AFTER the held prompt, not before', async () => {
    // `onStdinReady` is documented as running once the payload is out, and a
    // driver that both waits and opens a conversation must not have that
    // order inverted by the wait.
    const gate = heldGate();
    const { session, child } = openSession();
    const order: string[] = [];

    const handle = session.startTurn({
      stdinPayload: 'PROMPT\n',
      holdPrompt: gate.holdPrompt,
      onStdinReady: () => order.push(`ready:${child.stdin.written}`),
      onEvent: () => {},
    });
    expect(order).toEqual([]);

    gate.release();
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(['ready:PROMPT\n']);
    line(child, { done: true });
    await handle?.done;
  });
});

describe('asking a live session something out of band', () => {
  /** A reader matching one control reply by its request id. */
  const readReply =
    (id: string) =>
    (obj: unknown): string | null => {
      const row = obj as { reply?: string; total?: string };
      return row.reply === id ? (row.total ?? null) : null;
    };

  it('writes the question and resolves with the reply that answers it', async () => {
    const { session, child } = openSession();

    const answer = session.ask({
      line: '{"ask":"ctx-1"}\n',
      read: readReply('ctx-1'),
      timeoutMs: 1000,
    });
    expect(child.stdin.written).toContain('{"ask":"ctx-1"}');
    line(child, { reply: 'ctx-1', total: '98598' });

    expect(await answer).toBe('98598');
  });

  it('does not disturb the turn the reply arrived alongside', async () => {
    // The whole safety claim of this seam: the readout can be opened mid-turn,
    // so the control dialogue and the event stream must not consume each
    // other's lines.
    const { session, child } = openSession();
    const events: AgentEvent[] = [];
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    const answer = session.ask({
      line: '{"ask":"ctx-1"}\n',
      read: readReply('ctx-1'),
      timeoutMs: 1000,
    });
    line(child, { reply: 'ctx-1', total: '5' });
    line(child, { tool: 't1' });
    line(child, { done: true });

    expect(await answer).toBe('5');
    await handle?.done;
    expect(events.map((e) => e.type)).toEqual(['tool_result', 'turn_complete']);
  });

  it('gives each open question its OWN reply rather than the first to arrive', async () => {
    // Two readouts open at once is ordinary. Without per-question matching the
    // second would settle on the first's snapshot — a reading of a different
    // moment, silently.
    const { session, child } = openSession();

    const first = session.ask({
      line: '{"ask":"a"}\n',
      read: readReply('a'),
      timeoutMs: 1000,
    });
    const second = session.ask({
      line: '{"ask":"b"}\n',
      read: readReply('b'),
      timeoutMs: 1000,
    });
    line(child, { reply: 'b', total: 'B' });
    line(child, { reply: 'a', total: 'A' });

    expect(await first).toBe('A');
    expect(await second).toBe('B');
  });

  it('gives up with null when the deadline passes unanswered', async () => {
    vi.useFakeTimers();
    const { session } = openSession();

    const answer = session.ask({
      line: '{"ask":"a"}\n',
      read: readReply('a'),
      timeoutMs: 500,
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(await answer).toBeNull();
  });

  it('answers null the moment the process dies, without waiting out the clock', async () => {
    // Nothing would ever call the reader again, so the deadline would be the
    // only way out — and it is deliberately generous.
    vi.useFakeTimers();
    const { session, child } = openSession();

    const answer = session.ask({
      line: '{"ask":"a"}\n',
      read: readReply('a'),
      timeoutMs: 60_000,
    });
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(0);

    expect(await answer).toBeNull();
  });

  it('answers null without waiting when stdin will not take the question', async () => {
    const { session, child } = openSession();
    child.stdin.writable = false;

    expect(
      await session.ask({
        line: '{"ask":"a"}\n',
        read: readReply('a'),
        timeoutMs: 60_000,
      }),
    ).toBeNull();
  });

  it('survives a reader that throws, and keeps the turn stream alive', async () => {
    // A reader is adapter code parsing a version-volatile reply; a throw there
    // must not take down the stdout loop every turn depends on.
    const warn = vi.fn();
    const { session, child } = openSession(undefined, { warn });
    const events: AgentEvent[] = [];
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    const answer = session.ask({
      line: '{"ask":"a"}\n',
      read: () => {
        throw new Error('bad reply');
      },
      timeoutMs: 1000,
    });
    line(child, { reply: 'a' });

    expect(await answer).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad reply'));
    line(child, { done: true });
    await handle?.done;
    expect(events.map((e) => e.type)).toEqual(['turn_complete']);
  });
});

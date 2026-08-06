import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeSpawn } from '../__tests__/fake-child';
import type { AgentEvent } from '../adapters/adapter.types';
import { runCliSession, runHeadlessCli } from './spawn-cli';

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
  const row = obj as { done?: boolean; failed?: boolean };
  if (row.done === true) {
    return [COMPLETE];
  }
  if (row.failed === true) {
    return [{ type: 'error', message: 'result: is_error' }];
  }
  return [];
};

function openSession(
  child?: Parameters<typeof fakeSpawn>[0],
  logger?: { warn(message: string): void },
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

  it('settles the turn in flight when the process dies underneath it', async () => {
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    child.emit('close', null, 'SIGTERM');
    await handle?.done;

    expect(events).toEqual([{ type: 'turn_cancelled' }]);
    expect(session.alive).toBe(false);
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

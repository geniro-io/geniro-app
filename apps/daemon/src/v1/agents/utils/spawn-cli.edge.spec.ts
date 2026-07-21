import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../adapters/adapter.types';
import type { SpawnedProcess, SpawnFn } from './spawn-cli';
import { runHeadlessCli } from './spawn-cli';

// ── Minimal synchronous child-process fake (mirrors the adapter specs) ────────
class FakeReadable extends EventEmitter {
  setEncoding(): this {
    return this;
  }
  emitData(chunk: string): void {
    this.emit('data', chunk);
  }
}
class FakeWritable extends EventEmitter {
  written = '';
  write(chunk: string): boolean {
    this.written += chunk;
    return true;
  }
  end(): this {
    return this;
  }
}
class FakeChild extends EventEmitter {
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly stdin = new FakeWritable();
  kill(): boolean {
    return true;
  }
}

function fakeSpawn(): { spawn: SpawnFn; child: FakeChild } {
  const child = new FakeChild();
  const spawn: SpawnFn = () => child as unknown as SpawnedProcess;
  return { spawn, child };
}

const noopMapper = (): AgentEvent[] => [];

describe('runHeadlessCli terminal-event de-duplication', () => {
  it('emits exactly one terminal event when an error fires before a non-zero close', async () => {
    // A child can surface a process-level 'error' (e.g. EPIPE writing stdin,
    // or a spawn-level failure) and THEN node still fires 'close' with a
    // non-zero exit code. Each handler emits its own terminal event but only
    // 'done' is settle-guarded, so the second terminal event leaks through.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];

    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      mapper: noopMapper,
      onEvent: (e) => events.push(e),
      spawn,
    });

    child.emit('error', new Error('write EPIPE'));
    child.emit('close', 1, null);
    await handle.done;

    // After the turn has settled via the 'error' event, no further terminal
    // event may be emitted — the transcript would otherwise record two
    // contradictory terminal items for one turn.
    const terminalEvents = events.filter(
      (e) =>
        e.type === 'error' ||
        e.type === 'turn_complete' ||
        e.type === 'turn_cancelled',
    );
    expect(terminalEvents).toEqual([
      { type: 'error', message: 'claude process error: write EPIPE' },
    ]);
  });

  it('emits only the turn_complete when a success result precedes a non-zero exit', async () => {
    // The CLI printed a successful `result` (mapped to turn_complete) but the
    // process still exited non-zero. At most one terminal event must reach the
    // service — the turn_complete wins; the close-code error is suppressed.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const mapper = (obj: unknown): AgentEvent[] =>
      obj &&
      typeof obj === 'object' &&
      (obj as { type?: string }).type === 'result'
        ? [{ type: 'turn_complete', usage: null, stopReason: 'end_turn' }]
        : [];

    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      mapper,
      onEvent: (e) => events.push(e),
      spawn,
    });

    child.stdout.emitData('{"type":"result","is_error":false}\n');
    child.emit('close', 1, null);
    await handle.done;

    const terminal = events.filter(
      (e) =>
        e.type === 'error' ||
        e.type === 'turn_complete' ||
        e.type === 'turn_cancelled',
    );
    expect(terminal).toEqual([
      { type: 'turn_complete', usage: null, stopReason: 'end_turn' },
    ]);
  });

  it('normalizes a post-cancel error terminal to turn_cancelled', async () => {
    // On Stop the CLI reacts to the SIGTERM by printing an is_error result
    // (or exiting non-zero) BEFORE the signal-kill close — that error would
    // win the one-terminal race and record a fake failure for a deliberate
    // user cancel. After cancel(), an error terminal must read as cancelled.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const mapper = (obj: unknown): AgentEvent[] =>
      obj &&
      typeof obj === 'object' &&
      (obj as { type?: string }).type === 'result'
        ? [{ type: 'error', message: 'claude run failed' }]
        : [];

    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      mapper,
      onEvent: (e) => events.push(e),
      spawn,
    });

    handle.cancel();
    child.stdout.emitData('{"type":"result","is_error":true}\n');
    child.emit('close', 143, null);
    await handle.done;

    const terminal = events.filter(
      (e) =>
        e.type === 'error' ||
        e.type === 'turn_complete' ||
        e.type === 'turn_cancelled',
    );
    expect(terminal).toEqual([{ type: 'turn_cancelled' }]);
  });

  it('a genuine turn_complete that raced the cancel still wins over the kill', async () => {
    // The turn REALLY finished — the result line was already on the wire when
    // the user hit Stop. The completed outcome (and its usage) must survive;
    // only errors are rewritten by a pending cancel.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const mapper = (obj: unknown): AgentEvent[] =>
      obj &&
      typeof obj === 'object' &&
      (obj as { type?: string }).type === 'result'
        ? [{ type: 'turn_complete', usage: null, stopReason: 'end_turn' }]
        : [];

    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      mapper,
      onEvent: (e) => events.push(e),
      spawn,
    });

    handle.cancel();
    child.stdout.emitData('{"type":"result","is_error":false}\n');
    child.emit('close', 0, 'SIGTERM');
    await handle.done;

    const terminal = events.filter(
      (e) =>
        e.type === 'error' ||
        e.type === 'turn_complete' ||
        e.type === 'turn_cancelled',
    );
    expect(terminal).toEqual([
      { type: 'turn_complete', usage: null, stopReason: 'end_turn' },
    ]);
  });

  it('surfaces a synchronous stdin-write throw as a failed-to-write error event and settles', async () => {
    // A child whose stdin is already closed/destroyed (e.g. an unauthenticated
    // CLI that exited before we wrote) makes stdin.write throw synchronously.
    // The module promises a single settle point and that 'done' never rejects,
    // so the failure must surface as an error EVENT on a returned handle whose
    // done resolves — a regression that merely swallows the throw without
    // settling would wedge the turn forever.
    const { spawn, child } = fakeSpawn();
    child.stdin.write = (): boolean => {
      throw new Error('write EPIPE');
    };
    const events: AgentEvent[] = [];

    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinPayload: '{"type":"user"}\n',
      mapper: noopMapper,
      onEvent: (e) => events.push(e),
      spawn,
    });

    expect(events).toEqual([
      { type: 'error', message: 'failed to write claude stdin: write EPIPE' },
    ]);
    await handle.done; // settled — a wedged turn would time the test out
  });
});

describe('runHeadlessCli process-group cancellation', () => {
  it('signals the whole process group on cancel and escalates to SIGKILL', async () => {
    // The child is spawned `detached` (a group leader), so cancel must signal the
    // GROUP (`process.kill(-pid)`) to reap the tool/MCP grandchildren a coding
    // agent forks — a single-PID kill would orphan them — and force-kill the
    // group if SIGTERM doesn't land within the grace window.
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const child = new FakeChild();
      Object.defineProperty(child, 'pid', { value: 4242 });
      const spawn: SpawnFn = () => child as unknown as SpawnedProcess;

      const handle = runHeadlessCli({
        command: 'claude',
        args: [],
        cwd: '/proj',
        mapper: noopMapper,
        onEvent: () => {},
        spawn,
      });

      handle.cancel();
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');

      // Still alive after the grace window → escalate to a group SIGKILL.
      vi.advanceTimersByTime(2000);
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');

      child.emit('close', null, 'SIGKILL');
      await handle.done;
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('runHeadlessCli stream edge cases', () => {
  it('flushes a final stdout line with no trailing newline on close', async () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const mapper = (obj: unknown): AgentEvent[] =>
      obj &&
      typeof obj === 'object' &&
      (obj as { type?: string }).type === 'result'
        ? [{ type: 'turn_complete', usage: null, stopReason: 'end_turn' }]
        : [];

    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      mapper,
      onEvent: (e) => events.push(e),
      spawn,
    });

    // Final result line arrives with NO trailing newline — the buffer must flush
    // it on close rather than dropping the turn's terminal event.
    child.stdout.emitData('{"type":"result","is_error":false}');
    child.emit('close', 0, null);
    await handle.done;

    expect(events).toEqual([
      { type: 'turn_complete', usage: null, stopReason: 'end_turn' },
    ]);
  });

  it('surfaces an async stdin error (EPIPE) as a terminal error and settles', async () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinPayload: '{"type":"user"}\n',
      mapper: noopMapper,
      onEvent: (e) => events.push(e),
      spawn,
    });

    child.stdin.emit('error', new Error('write EPIPE'));
    await handle.done;

    expect(events).toEqual([
      { type: 'error', message: 'claude stdin error: write EPIPE' },
    ]);
  });

  it('ignores a stdin error after the terminal event and still waits for close', async () => {
    // After the terminal event the turn is already decided — the late EPIPE
    // from closing a kept-open stdin as the child exits must neither add a
    // second terminal event nor settle `done` early: settling before `close`
    // would skip the final buffer flush and resolve before stdout drains.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const mapper = (obj: unknown): AgentEvent[] =>
      obj &&
      typeof obj === 'object' &&
      (obj as { type?: string }).type === 'result'
        ? [
            {
              type: 'turn_complete',
              usage: null,
              stopReason: 'end_turn',
              finalText: null,
            },
          ]
        : [];

    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinPayload: '{"type":"user"}\n',
      keepStdinOpen: true,
      mapper,
      onEvent: (e) => events.push(e),
      spawn,
    });

    child.stdout.emitData('{"type":"result"}\n'); // terminal decided
    child.stdin.emit('error', new Error('write EPIPE')); // late EPIPE

    let settled = false;
    void handle.done.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false); // done still waits for close

    child.emit('close', 0, null);
    await handle.done;

    // Exactly one terminal event — the late stdin error emitted nothing.
    expect(events).toEqual([
      {
        type: 'turn_complete',
        usage: null,
        stopReason: 'end_turn',
        finalText: null,
      },
    ]);
  });
});

describe('runHeadlessCli spawn failure', () => {
  it('a throwing spawn yields a failed-to-spawn error event, a resolved done, and an inert cancel', async () => {
    // The spawn call itself can throw synchronously (EACCES, a bad binary
    // path). The settle contract still holds: the failure is an error EVENT,
    // `done` resolves, and the returned handle's cancel is a safe no-op —
    // there is no child to kill.
    const events: AgentEvent[] = [];

    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      mapper: noopMapper,
      onEvent: (e) => events.push(e),
      spawn: () => {
        throw new Error('EACCES');
      },
    });

    expect(events).toEqual([
      { type: 'error', message: 'failed to spawn claude: EACCES' },
    ]);
    await handle.done; // resolves — done never rejects

    expect(() => handle.cancel()).not.toThrow();
    // The no-op cancel emitted nothing further — still exactly one terminal.
    expect(events).toEqual([
      { type: 'error', message: 'failed to spawn claude: EACCES' },
    ]);
    expect(handle.respondApproval('req-1', true)).toBe(false);
  });
});

describe('approval seam edges', () => {
  it('answers before the terminal event, refuses after it', () => {
    const { spawn, child } = fakeSpawn();
    const handle = runHeadlessCli({
      command: 'x',
      args: [],
      cwd: '/tmp',
      spawn,
      keepStdinOpen: true,
      buildApprovalResponse: (id, allow) => `${id}:${allow}\n`,
      mapper: (obj) =>
        (obj as { type?: string }).type === 'result'
          ? [
              {
                type: 'turn_complete',
                usage: null,
                stopReason: null,
                finalText: null,
              },
            ]
          : [],
      onEvent: () => {},
    });

    expect(handle.respondApproval('req-1', true)).toBe(true);
    expect(child.stdin.written).toContain('req-1:true');

    child.stdout.emitData('{"type":"result"}\n');
    const before = child.stdin.written;
    expect(handle.respondApproval('req-2', false)).toBe(false);
    expect(child.stdin.written).toBe(before);
  });

  it('respondApproval is a no-op false without a buildApprovalResponse encoder', () => {
    const { spawn: spawnFn, child } = fakeSpawn();
    const handle = runHeadlessCli({
      command: 'x',
      args: [],
      cwd: '/tmp',
      spawn: spawnFn,
      mapper: () => [],
      onEvent: () => {},
    });
    expect(handle.respondApproval('req-1', true)).toBe(false);
    expect(child.stdin.written).toBe('');
  });
});

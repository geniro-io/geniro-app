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

  it('does not throw out of the call when writing the stdin payload fails', () => {
    // A child whose stdin is already closed/destroyed (e.g. an unauthenticated
    // CLI that exited before we wrote) makes stdin.write throw synchronously.
    // The module promises a single settle point and that 'done' never rejects,
    // so a stdin failure must surface as a handle (ideally an error event), not
    // as an exception that escapes the call and never returns a handle.
    const { spawn, child } = fakeSpawn();
    child.stdin.write = (): boolean => {
      throw new Error('write EPIPE');
    };

    expect(() =>
      runHeadlessCli({
        command: 'claude',
        args: [],
        cwd: '/proj',
        stdinPayload: '{"type":"user"}\n',
        mapper: noopMapper,
        onEvent: () => {},
        spawn,
      }),
    ).not.toThrow();
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

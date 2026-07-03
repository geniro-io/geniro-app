import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import type { SpawnedProcess, SpawnFn } from '../../utils/spawn-cli';
import type { AgentEvent } from '../adapter.types';
import { ClaudeAdapter, mapClaudeMessage } from './claude.adapter';

// ── Minimal synchronous child-process fake (no real I/O timing) ──────────────
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
  killSignal: NodeJS.Signals | null = null;
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killSignal = signal;
    return true;
  }
}

function fakeSpawn(): {
  spawn: SpawnFn;
  child: FakeChild;
  captured: { command?: string; args?: string[]; cwd?: string };
} {
  const child = new FakeChild();
  const captured: { command?: string; args?: string[]; cwd?: string } = {};
  const spawn: SpawnFn = (command, args, options) => {
    captured.command = command;
    captured.args = args;
    captured.cwd = options.cwd;
    return child as unknown as SpawnedProcess;
  };
  return { spawn, child, captured };
}

describe('mapClaudeMessage', () => {
  it('extracts the session id from system/init', () => {
    expect(
      mapClaudeMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
      }),
    ).toEqual([{ type: 'session', sessionId: 'sess-1' }]);
  });

  it('ignores non-init system events (hook_*, post_turn_summary)', () => {
    expect(
      mapClaudeMessage({ type: 'system', subtype: 'hook_started' }),
    ).toEqual([]);
    expect(
      mapClaudeMessage({ type: 'system', subtype: 'post_turn_summary' }),
    ).toEqual([]);
  });

  it('maps assistant text/thinking/tool_use blocks in order', () => {
    const events = mapClaudeMessage({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'let me think' },
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { path: '/x' } },
        ],
      },
    });
    expect(events).toEqual([
      { type: 'reasoning', text: 'let me think' },
      { type: 'text', text: 'hello' },
      { type: 'tool_call', id: 't1', name: 'Read', input: { path: '/x' } },
    ]);
  });

  it('maps a user tool_result block', () => {
    expect(
      mapClaudeMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: 'file body',
              is_error: false,
            },
          ],
        },
      }),
    ).toEqual([
      {
        type: 'tool_result',
        id: 't1',
        name: null,
        result: 'file body',
        isError: false,
      },
    ]);
  });

  it('maps a successful result to turn_complete with usage', () => {
    expect(
      mapClaudeMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'pong',
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 3 },
        total_cost_usd: 0.14,
      }),
    ).toEqual([
      {
        type: 'turn_complete',
        usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.14 },
        stopReason: 'end_turn',
      },
    ]);
  });

  it('maps an error result to an error event', () => {
    expect(
      mapClaudeMessage({
        type: 'result',
        is_error: true,
        result: 'context limit exceeded',
      }),
    ).toEqual([{ type: 'error', message: 'context limit exceeded' }]);
  });

  it('ignores unknown event types and non-objects', () => {
    expect(mapClaudeMessage({ type: 'rate_limit_event', tier: 'x' })).toEqual(
      [],
    );
    expect(mapClaudeMessage('garbage')).toEqual([]);
    expect(mapClaudeMessage(null)).toEqual([]);
    expect(mapClaudeMessage(42)).toEqual([]);
  });
});

describe('ClaudeAdapter', () => {
  it('spawns with stream-json flags, streams a turn, and sends the prompt on stdin', async () => {
    const { spawn, child, captured } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new ClaudeAdapter({ spawn }).start(
      { prompt: 'say hi', cwd: '/proj', model: 'opus' },
      (e) => events.push(e),
    );

    // stdout arrives in arbitrary chunks — the assistant line is split.
    child.stdout.emitData(
      '{"type":"system","subtype":"init","session_id":"s1"}\n{"type":"assist',
    );
    child.stdout.emitData(
      'ant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}\n',
    );
    child.stdout.emitData(
      '{"type":"result","is_error":false,"result":"hi","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1},"total_cost_usd":0.01}\n',
    );
    child.emit('close', 0, null);
    await handle.done;

    expect(events).toEqual([
      { type: 'session', sessionId: 's1' },
      { type: 'text', text: 'hi' },
      {
        type: 'turn_complete',
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
        stopReason: 'end_turn',
      },
    ]);
    expect(captured.command).toBe('claude');
    expect(captured.args).toEqual(
      expect.arrayContaining([
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
      ]),
    );
    expect(captured.args).toEqual(expect.arrayContaining(['--model', 'opus']));
    expect(captured.cwd).toBe('/proj');
    expect(JSON.parse(child.stdin.written.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'say hi' }] },
    });
  });

  it('passes --resume when a prior session id is supplied', () => {
    const { spawn, captured } = fakeSpawn();
    new ClaudeAdapter({ spawn }).start(
      { prompt: 'go', cwd: '/proj', resumeSessionId: 'prev-1' },
      () => {},
    );
    expect(captured.args).toEqual(
      expect.arrayContaining(['--resume', 'prev-1']),
    );
  });

  it('emits turn_cancelled when the process is killed', async () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new ClaudeAdapter({ spawn }).start(
      { prompt: 'go', cwd: '/proj' },
      (e) => events.push(e),
    );
    handle.cancel();
    child.emit('close', null, 'SIGTERM');
    await handle.done;

    expect(child.killSignal).toBe('SIGTERM');
    expect(events).toEqual([{ type: 'turn_cancelled' }]);
  });

  it('emits an error event on a non-zero exit with the stderr tail', async () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new ClaudeAdapter({ spawn }).start(
      { prompt: 'go', cwd: '/proj' },
      (e) => events.push(e),
    );
    child.stderr.emitData('not authenticated');
    child.emit('close', 1, null);
    await handle.done;

    expect(events).toEqual([
      {
        type: 'error',
        message: 'claude exited with code 1: not authenticated',
      },
    ]);
  });
});

import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SpawnedProcess, SpawnFn } from '../../utils/spawn-cli';
import type { AgentEvent } from '../adapter.types';
import { CursorAdapter, mapCursorMessage } from './cursor.adapter';

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

function fakeSpawn(): {
  spawn: SpawnFn;
  child: FakeChild;
  captured: { command?: string; args?: string[] };
} {
  const child = new FakeChild();
  const captured: { command?: string; args?: string[] } = {};
  const spawn: SpawnFn = (command, args) => {
    captured.command = command;
    captured.args = args;
    return child as unknown as SpawnedProcess;
  };
  return { spawn, child, captured };
}

describe('mapCursorMessage', () => {
  it('reads the session id from a system event under any known key', () => {
    expect(mapCursorMessage({ type: 'system', chatId: 'c-9' })).toEqual([
      { type: 'session', sessionId: 'c-9' },
    ]);
    expect(mapCursorMessage({ type: 'system', session_id: 's-9' })).toEqual([
      { type: 'session', sessionId: 's-9' },
    ]);
  });

  it('maps assistant nested content blocks', () => {
    expect(
      mapCursorMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }] },
      }),
    ).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('maps a flat assistant text shape', () => {
    expect(mapCursorMessage({ type: 'assistant', text: 'flat hi' })).toEqual([
      { type: 'text', text: 'flat hi' },
    ]);
  });

  it('surfaces a session id riding on a non-system event, then the payload', () => {
    expect(
      mapCursorMessage({ type: 'assistant', chat_id: 'c-1', text: 'yo' }),
    ).toEqual([
      { type: 'session', sessionId: 'c-1' },
      { type: 'text', text: 'yo' },
    ]);
  });

  it('maps a top-level tool_call', () => {
    expect(
      mapCursorMessage({
        type: 'tool_call',
        id: 't1',
        name: 'Bash',
        input: { cmd: 'ls' },
      }),
    ).toEqual([
      { type: 'tool_call', id: 't1', name: 'Bash', input: { cmd: 'ls' } },
    ]);
  });

  it('maps a successful result with a cost_usd variant', () => {
    expect(
      mapCursorMessage({
        type: 'result',
        is_error: false,
        cost_usd: 0.02,
        stop_reason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 1 },
      }),
    ).toEqual([
      {
        type: 'turn_complete',
        usage: {
          inputTokens: 5,
          outputTokens: 1,
          contextTokens: 5,
          costUsd: 0.02,
        },
        stopReason: 'end_turn',
        finalText: null,
      },
    ]);
  });

  it('maps an error result', () => {
    expect(
      mapCursorMessage({
        type: 'result',
        is_error: true,
        error: 'rate limited',
      }),
    ).toEqual([{ type: 'error', message: 'rate limited' }]);
  });

  it('ignores unknown types and non-objects', () => {
    expect(mapCursorMessage({ type: 'heartbeat' })).toEqual([]);
    expect(mapCursorMessage(null)).toEqual([]);
    expect(mapCursorMessage([1, 2, 3])).toEqual([]);
  });

  it('degrades to a fresh session when a system event carries no recognized key', () => {
    // No session/chat/thread id under any known key → no session event, so the
    // turn starts fresh instead of resuming a bogus id.
    expect(mapCursorMessage({ type: 'system', subtype: 'init' })).toEqual([]);
  });
});

describe('CursorAdapter', () => {
  it('delivers the prompt on stdin — never on ps-visible argv — and streams a turn', async () => {
    const { spawn, child, captured } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new CursorAdapter({ spawn }).start(
      { prompt: 'list files', cwd: '/proj' },
      (e) => events.push(e),
    );

    child.stdout.emitData('{"type":"system","chatId":"c-1"}\n');
    child.stdout.emitData('{"type":"assistant","text":"done"}\n');
    child.stdout.emitData('{"type":"result","is_error":false}\n');
    child.emit('close', 0, null);
    await handle.done;

    expect(captured.command).toBe('cursor-agent');
    expect(captured.args).toEqual(
      expect.arrayContaining([
        '-p',
        '--output-format',
        'stream-json',
        '--force',
      ]),
    );
    // argv is readable by any local account via ps; the prompt (user task
    // text + upstream node outputs) must ride stdin instead.
    expect(captured.args).not.toContain('list files');
    expect(child.stdin.written).toBe('list files');
    expect(events).toEqual([
      { type: 'session', sessionId: 'c-1' },
      { type: 'text', text: 'done' },
      {
        type: 'turn_complete',
        usage: {
          inputTokens: null,
          outputTokens: null,
          contextTokens: null,
          costUsd: null,
        },
        stopReason: null,
        finalText: null,
      },
    ]);
  });

  it('passes --resume with the prior chat id', () => {
    const { spawn, captured } = fakeSpawn();
    new CursorAdapter({ spawn }).start(
      { prompt: 'go', cwd: '/proj', resumeSessionId: 'c-prev' },
      () => {},
    );
    expect(captured.args).toEqual(
      expect.arrayContaining(['--resume', 'c-prev']),
    );
  });

  it('a dash-leading prompt can never be parsed as a CLI flag — it rides stdin', () => {
    const { spawn, child, captured } = fakeSpawn();
    new CursorAdapter({ spawn }).start(
      { prompt: '--help', cwd: '/proj' },
      () => {},
    );
    expect(captured.args).not.toContain('--help');
    expect(child.stdin.written).toBe('--help');
  });

  it('fails fast with an error event on a non-zero exit', async () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new CursorAdapter({ spawn }).start(
      { prompt: 'go', cwd: '/proj' },
      (e) => events.push(e),
    );
    child.stderr.emitData('not logged in');
    child.emit('close', 1, null);
    await handle.done;

    expect(events).toEqual([
      {
        type: 'error',
        message: 'cursor-agent exited with code 1: not logged in',
      },
    ]);
  });
});

describe('CursorAdapter graph-node extras', () => {
  it('prepends the system prompt to the stdin prompt (no CLI flag exists)', () => {
    const { spawn, child, captured } = fakeSpawn();
    new CursorAdapter({ spawn }).start(
      {
        prompt: 'review the diff',
        cwd: '/proj',
        systemPrompt: 'You are the reviewer.',
        approvalMode: 'ask',
      },
      () => {},
    );
    expect(child.stdin.written).toBe('You are the reviewer.\n\nreview the diff');
    // The role text is part of the prompt payload — it stays off argv too.
    expect(
      captured.args!.some((a) => a.includes('reviewer')),
    ).toBe(false);
    // ask degrades to --force (auto-approve) — cursor-agent has no callback.
    expect(captured.args).toEqual(expect.arrayContaining(['--force']));
  });

  it('passes --trust only when the turn sets trustWorkspace', () => {
    const plain = fakeSpawn();
    new CursorAdapter({ spawn: plain.spawn }).start(
      { prompt: 'go', cwd: '/proj' },
      () => {},
    );
    expect(plain.captured.args).not.toEqual(
      expect.arrayContaining(['--trust']),
    );

    const trusted = fakeSpawn();
    new CursorAdapter({ spawn: trusted.spawn }).start(
      { prompt: 'go', cwd: '/probe-tmp', trustWorkspace: true },
      () => {},
    );
    expect(trusted.captured.args).toEqual(expect.arrayContaining(['--trust']));
    // Blanket approval must never ride the argv — approval stays scoped to
    // the geniro entry's autoApprove + `mcp enable geniro`.
    expect(trusted.captured.args).not.toContain('--approve-mcps');
  });
});

describe('CursorAdapter binary override', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('spawns the GENIRO_CURSOR_BIN override instead of the bare binary', () => {
    vi.stubEnv('GENIRO_CURSOR_BIN', '/opt/tools/cursor-agent');
    const { spawn, captured } = fakeSpawn();
    new CursorAdapter({ spawn }).start({ prompt: 'p', cwd: '/proj' }, () => {});
    expect(captured.command).toBe('/opt/tools/cursor-agent');
  });
});

import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SpawnedProcess, SpawnFn } from '../../utils/spawn-cli';
import type { AcpToolCall } from '../acp/acp.types';
import type { AgentEvent, AgentTurnInput } from '../adapter.types';
import { CursorAcpAdapter, cursorAutoDecision } from './cursor-acp.adapter';

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
  ended = false;
  write(chunk: string): boolean {
    this.written += chunk;
    return true;
  }
  end(): this {
    this.ended = true;
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
  captured: { command?: string; args?: string[]; env?: NodeJS.ProcessEnv };
} {
  const child = new FakeChild();
  const captured: {
    command?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
  } = {};
  const spawn: SpawnFn = (command, args, options) => {
    captured.command = command;
    captured.args = args;
    captured.env = options.env;
    return child as unknown as SpawnedProcess;
  };
  return { spawn, child, captured };
}

/** The frames the adapter wrote to the child's stdin, parsed. */
function framesOn(child: FakeChild): Record<string, unknown>[] {
  return child.stdin.written
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const BASE: AgentTurnInput = { prompt: 'ship it', cwd: '/repo' };

function toolCall(overrides: Partial<AcpToolCall> = {}): AcpToolCall {
  return {
    toolCallId: 't-1',
    name: 'write_file',
    status: null,
    kind: 'edit',
    rawInput: null,
    rawOutput: null,
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.GENIRO_CURSOR_API_KEY;
  delete process.env.GENIRO_CURSOR_BIN;
});

describe('CursorAcpAdapter spawn', () => {
  it('runs the ACP server and keeps every turn parameter out of argv', () => {
    const { spawn, captured } = fakeSpawn();
    new CursorAcpAdapter({ spawn }).start(
      {
        ...BASE,
        model: 'sonnet',
        resumeSessionId: 'prior',
        approvalMode: 'plan',
        mcpEndpoint: { url: 'http://127.0.0.1:9/mcp', token: 'secret-token' },
      },
      () => {},
    );
    expect(captured.command).toBe('cursor-agent');
    expect(captured.args).toEqual(['acp']);
    // The whole point of keeping the call token in-protocol: argv is readable
    // by every local account through `ps`.
    expect(JSON.stringify(captured.args)).not.toContain('secret-token');
    expect(JSON.stringify(captured.args)).not.toContain('ship it');
  });

  it('honours the Settings cliPaths override per turn', () => {
    const { spawn, captured } = fakeSpawn();
    process.env.GENIRO_CURSOR_BIN = '/opt/cursor-agent';
    new CursorAcpAdapter({ spawn }).start(BASE, () => {});
    expect(captured.command).toBe('/opt/cursor-agent');
  });

  it('re-injects the Cursor key for its own child only', () => {
    const { spawn, captured } = fakeSpawn();
    process.env.GENIRO_CURSOR_API_KEY = 'ck-live';
    new CursorAcpAdapter({ spawn }).start(BASE, () => {});
    expect(captured.env?.CURSOR_API_KEY).toBe('ck-live');
    // The GENIRO_-prefixed original is stripped from every child env.
    expect(captured.env?.GENIRO_CURSOR_API_KEY).toBeUndefined();
  });

  it('opens the handshake on stdin and holds stdin open for the dialogue', () => {
    const { spawn, child } = fakeSpawn();
    new CursorAcpAdapter({ spawn, clientVersion: '9.9.9' }).start(
      BASE,
      () => {},
    );
    const [first] = framesOn(child);
    expect(first).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientInfo: { name: 'geniro', version: '9.9.9' },
      },
    });
    // ACP is full-duplex: closing stdin after the opening frame would strand
    // every reply the agent is waiting on.
    expect(child.stdin.ended).toBe(false);
  });

  it('drives a turn end to end through the ACP handshake', async () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new CursorAcpAdapter({ spawn }).start(BASE, (event) =>
      events.push(event),
    );

    child.stdout.emitData(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 'sess-9' } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-9',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'done' },
          },
        },
      })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })}\n`,
    );
    child.emit('close', 0, null);
    await handle.done;

    expect(events).toEqual([
      { type: 'session', sessionId: 'sess-9' },
      { type: 'text', text: 'done' },
      {
        type: 'turn_complete',
        usage: {
          inputTokens: null,
          outputTokens: null,
          contextTokens: null,
          costUsd: null,
        },
        stopReason: 'end_turn',
        finalText: 'done',
      },
    ]);
    // The prompt reached the agent in-protocol.
    expect(
      framesOn(child).find((frame) => frame.method === 'session/prompt')
        ?.params,
    ).toEqual({
      sessionId: 'sess-9',
      prompt: [{ type: 'text', text: 'ship it' }],
    });
  });
});

describe('CursorAcpAdapter turn shaping', () => {
  it('inlines a graph node role into the prompt, as the legacy adapter does', () => {
    const { spawn, child } = fakeSpawn();
    new CursorAcpAdapter({ spawn }).start(
      { ...BASE, systemPrompt: 'You are a reviewer.' },
      () => {},
    );
    child.stdout.emitData(
      `${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({ id: 2, result: { sessionId: 's' } })}\n`,
    );

    const prompt = framesOn(child).find(
      (frame) => frame.method === 'session/prompt',
    )?.params as { prompt: { text: string }[] };
    expect(prompt.prompt[0].text).toBe('You are a reviewer.\n\nship it');
  });

  it('says so when a requested model cannot be carried', () => {
    const { spawn } = fakeSpawn();
    const events: AgentEvent[] = [];
    new CursorAcpAdapter({ spawn }).start(
      { ...BASE, model: 'gpt-5' },
      (event) => events.push(event),
    );
    expect(events).toContainEqual({
      type: 'notice',
      message:
        "model 'gpt-5' was not applied: ACP carries no per-session model selection, so this turn runs on the agent's configured default",
    });
  });

  it('stays silent when every turn parameter has an ACP home', () => {
    const { spawn } = fakeSpawn();
    const events: AgentEvent[] = [];
    new CursorAcpAdapter({ spawn }).start(BASE, (event) => events.push(event));
    expect(events).toEqual([]);
  });

  it('asks for cursor plan mode only in the plan approval mode', () => {
    for (const [mode, expected] of [
      ['plan', 'plan'],
      ['ask', undefined],
      ['auto', undefined],
    ] as const) {
      const { spawn, child } = fakeSpawn();
      new CursorAcpAdapter({ spawn }).start(
        { ...BASE, approvalMode: mode },
        () => {},
      );
      child.stdout.emitData(
        `${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`,
      );
      child.stdout.emitData(
        `${JSON.stringify({
          id: 2,
          result: {
            sessionId: 's',
            modes: {
              currentModeId: 'agent',
              availableModes: [{ id: 'agent' }, { id: 'plan' }],
            },
          },
        })}\n`,
      );
      const setMode = framesOn(child).find(
        (frame) => frame.method === 'session/set_mode',
      )?.params as { modeId: string } | undefined;
      expect(setMode?.modeId).toBe(expected);
    }
  });
});

describe('cursorAutoDecision', () => {
  it('auto-approves everything in auto mode, preserving unattended semantics', () => {
    expect(cursorAutoDecision('auto', toolCall())).toBe('allow');
    expect(cursorAutoDecision('auto', toolCall({ kind: 'execute' }))).toBe(
      'allow',
    );
  });

  it('auto-approves a legacy turn that carries no mode at all', () => {
    expect(cursorAutoDecision(undefined, toolCall())).toBe('allow');
  });

  it('defers every permission to the user in ask mode', () => {
    // The capability the legacy `-p --force` adapter simply did not have.
    expect(cursorAutoDecision('ask', toolCall())).toBeNull();
    expect(cursorAutoDecision('ask', toolCall({ kind: 'read' }))).toBeNull();
  });

  it('auto-approves edits only, in acceptEdits mode', () => {
    expect(cursorAutoDecision('acceptEdits', toolCall({ kind: 'edit' }))).toBe(
      'allow',
    );
    expect(
      cursorAutoDecision('acceptEdits', toolCall({ kind: 'execute' })),
    ).toBeNull();
    // Destructive kinds are NOT edits — they keep the user verdict.
    expect(
      cursorAutoDecision('acceptEdits', toolCall({ kind: 'delete' })),
    ).toBeNull();
    expect(
      cursorAutoDecision('acceptEdits', toolCall({ kind: null })),
    ).toBeNull();
  });

  it('defers in plan mode', () => {
    expect(cursorAutoDecision('plan', toolCall())).toBeNull();
  });
});

describe('CursorAcpAdapter misuse', () => {
  it('fails loudly if the stateless mapper path is ever reached', () => {
    // ACP state cannot live on the adapter (one instance serves N concurrent
    // turns), so a future refactor that drops createTurnDriver must not
    // silently fall back to a mapper that cannot work.
    class Exposed extends CursorAcpAdapter {
      callMapMessage(): unknown {
        return this['mapMessage']();
      }
    }
    expect(() => new Exposed().callMapMessage()).toThrow(
      /drives ACP through its per-turn driver/,
    );
  });

  it('gives each concurrent turn its own protocol state', () => {
    const adapter = new CursorAcpAdapter();
    const first = fakeSpawn();
    const second = fakeSpawn();
    const eventsA: AgentEvent[] = [];
    const eventsB: AgentEvent[] = [];
    new CursorAcpAdapter({ spawn: first.spawn }).start(BASE, (e) =>
      eventsA.push(e),
    );
    new CursorAcpAdapter({ spawn: second.spawn }).start(
      { ...BASE, prompt: 'other' },
      (e) => eventsB.push(e),
    );
    first.child.stdout.emitData(
      `${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`,
    );
    first.child.stdout.emitData(
      `${JSON.stringify({ id: 2, result: { sessionId: 'a' } })}\n`,
    );
    second.child.stdout.emitData(
      `${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`,
    );
    second.child.stdout.emitData(
      `${JSON.stringify({ id: 2, result: { sessionId: 'b' } })}\n`,
    );
    expect(eventsA).toEqual([{ type: 'session', sessionId: 'a' }]);
    expect(eventsB).toEqual([{ type: 'session', sessionId: 'b' }]);
    expect(adapter.kind).toBe('cursor-agent');
  });
});

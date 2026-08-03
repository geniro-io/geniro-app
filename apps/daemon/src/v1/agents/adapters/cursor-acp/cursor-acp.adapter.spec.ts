import type { ChildProcess } from 'node:child_process';
import type { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';

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

/** One NDJSON line of the agent's stdout. */
function stdoutLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/** A `session/update` notification wrapping one update payload. */
function sessionUpdate(payload: Record<string, unknown>): string {
  return stdoutLine({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 's', update: payload },
  });
}

/** The two `*_once` options every ACP permission request must offer. */
const ONCE_OPTIONS = [
  { optionId: 'o-allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'o-reject', name: 'Reject', kind: 'reject_once' },
];

/** Drive the handshake so the child is inside a live prompt (request id 3). */
function handshake(child: FakeChild): void {
  child.stdout.emitData(
    stdoutLine({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }),
  );
  child.stdout.emitData(
    stdoutLine({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } }),
  );
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

/**
 * Answers a utility command (`runCommand`, not `start`) with canned stdout,
 * capturing its argv and options. A turn is spawned through `spawn`;
 * everything else runs through `execFileFn`. A null stdout is the
 * command-failed signal — `runCommand` swallows the error and returns null.
 */
function fakeListing(stdout: string | null): {
  execFileFn: typeof execFile;
  captured: {
    args?: readonly string[];
    opts?: { cwd?: string; detached?: boolean };
  };
} {
  const captured: {
    args?: readonly string[];
    opts?: { cwd?: string; detached?: boolean };
  } = {};
  const execFileFn = ((
    _cmd: string,
    args: readonly string[],
    opts: { cwd?: string; detached?: boolean },
    cb: (err: Error | null, out: string) => void,
  ) => {
    captured.args = args;
    captured.opts = opts;
    if (stdout === null) {
      cb(new Error('spawn failed'), '');
    } else {
      cb(null, stdout);
    }
    return { pid: 4242 } as ChildProcess;
  }) as unknown as typeof execFile;
  return { execFileFn, captured };
}

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
          contextWindowTokens: null,
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

describe('CursorAcpAdapter permission round-trip', () => {
  it('auto-approves an edit whose permission request omits the tool kind', () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    new CursorAcpAdapter({ spawn }).start(
      { ...BASE, approvalMode: 'acceptEdits' },
      (event) => events.push(event),
    );
    handshake(child);
    // The agent states the call's kind once, on the tool_call update…
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 't-1',
        name: 'write_file',
        kind: 'edit',
        rawInput: { path: 'a.ts' },
      }),
    );
    // …then asks permission with a ToolCallUpdate that carries only the id,
    // which is protocol-legal — every other field on it is optional.
    child.stdout.emitData(
      stdoutLine({
        jsonrpc: '2.0',
        id: 7,
        method: 'session/request_permission',
        params: {
          sessionId: 's',
          toolCall: { toolCallId: 't-1' },
          options: ONCE_OPTIONS,
        },
      }),
    );

    // acceptEdits promises unattended file edits; parking this one on a human
    // card would stall an unattended graph node on every edit it makes.
    expect(framesOn(child).find((frame) => frame.id === 7)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'o-allow' },
    });
    expect(events.filter((event) => event.type === 'approval_request')).toEqual(
      [],
    );
  });

  it('delivers an ask-mode verdict to the running agent as a selected option', () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const handle = new CursorAcpAdapter({ spawn }).start(
      { ...BASE, approvalMode: 'ask' },
      (event) => events.push(event),
    );
    handshake(child);
    child.stdout.emitData(
      stdoutLine({
        jsonrpc: '2.0',
        id: 7,
        method: 'session/request_permission',
        params: {
          sessionId: 's',
          toolCall: {
            toolCallId: 't-1',
            name: 'write_file',
            kind: 'edit',
            rawInput: { path: 'a.ts' },
          },
          options: ONCE_OPTIONS,
        },
      }),
    );
    expect(events).toContainEqual({
      type: 'approval_request',
      id: 'n:7',
      toolName: 'write_file',
      input: { path: 'a.ts' },
    });

    // The verdict has to travel adapter → per-turn driver → child stdin. A
    // driver assembled without an approval encoder would silently drop it and
    // park every ask-mode cursor turn until it timed out.
    expect(handle.respondApproval('n:7', true)).toBe(true);
    expect(framesOn(child).find((frame) => frame.id === 7)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'o-allow' },
    });
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

  it('keeps two interleaved turns of ONE adapter instance on separate protocol state', () => {
    // Production has exactly one CursorAcpAdapter — a default-scope Nest
    // provider, held as a single `cursor` by the graph executor — serving
    // every node of a fanned-out graph. State that must not cross-wire
    // (session id, the request-id counter, the stdin writer) is only
    // exercised when both turns come from the SAME instance.
    const childA = new FakeChild();
    const childB = new FakeChild();
    const queued = [childA, childB];
    const spawn: SpawnFn = () => queued.shift() as unknown as SpawnedProcess;
    const adapter = new CursorAcpAdapter({ spawn });
    const eventsA: AgentEvent[] = [];
    const eventsB: AgentEvent[] = [];
    adapter.start({ ...BASE, prompt: 'turn A' }, (e) => eventsA.push(e));
    adapter.start({ ...BASE, prompt: 'turn B' }, (e) => eventsB.push(e));

    // Interleaved and out of order: both turns number their requests from 1,
    // so a shared counter or a shared pending map would route B's reply into
    // A's state machine.
    childA.stdout.emitData(
      stdoutLine({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }),
    );
    childB.stdout.emitData(
      stdoutLine({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }),
    );
    childB.stdout.emitData(
      stdoutLine({ jsonrpc: '2.0', id: 2, result: { sessionId: 'sess-b' } }),
    );
    childA.stdout.emitData(
      stdoutLine({ jsonrpc: '2.0', id: 2, result: { sessionId: 'sess-a' } }),
    );

    expect(eventsA).toEqual([{ type: 'session', sessionId: 'sess-a' }]);
    expect(eventsB).toEqual([{ type: 'session', sessionId: 'sess-b' }]);
    // Each child was prompted on its OWN session with its OWN prompt — a
    // hoisted session id or stdin writer sends one turn's prompt down the
    // other turn's pipe, or names the wrong session on it.
    expect(
      framesOn(childA).find((frame) => frame.method === 'session/prompt')
        ?.params,
    ).toEqual({
      sessionId: 'sess-a',
      prompt: [{ type: 'text', text: 'turn A' }],
    });
    expect(
      framesOn(childB).find((frame) => frame.method === 'session/prompt')
        ?.params,
    ).toEqual({
      sessionId: 'sess-b',
      prompt: [{ type: 'text', text: 'turn B' }],
    });
  });
  describe('listMcpServers', () => {
    it('asks the CLI in the folder it was given, in its own process group', async () => {
      const { execFileFn, captured } = fakeListing('probe: ready\n');

      await new CursorAcpAdapter({ execFileFn }).listMcpServers({
        cwd: '/proj',
      });

      expect(captured.args).toEqual(['mcp', 'list']);
      // The folder IS the question: `.cursor/mcp.json` is visible only from
      // its own directory, so a listing taken elsewhere is confidently wrong.
      expect(captured.opts?.cwd).toBe('/proj');
      // The command health-checks, which launches the user's own stdio
      // servers as children — killing only the CLI would strand them.
      expect(captured.opts?.detached).toBe(true);
    });

    it('reports the servers the CLI listed', async () => {
      const { execFileFn } = fakeListing(
        'probe-good: ready\nprobe-broken: Error: Connection failed\n',
      );

      await expect(
        new CursorAcpAdapter({ execFileFn }).listMcpServers({ cwd: '/proj' }),
      ).resolves.toEqual({
        ok: true,
        servers: [
          {
            name: 'probe-good',
            target: null,
            transport: null,
            status: 'connected',
            detail: null,
          },
          {
            name: 'probe-broken',
            target: null,
            transport: null,
            status: 'failed',
            detail: 'Connection failed',
          },
        ],
      });
    });

    it('reports an empty folder as an EMPTY listing, not a failure', async () => {
      const { execFileFn } = fakeListing(
        'No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)\n',
      );

      await expect(
        new CursorAcpAdapter({ execFileFn }).listMcpServers({ cwd: '/proj' }),
      ).resolves.toEqual({ ok: true, servers: [] });
    });

    it('reports a command that could not be run as a FAILURE, never as empty', async () => {
      // null stdout is the missing binary / non-zero exit / deadline signal.
      // An `ok: true, servers: []` here would be cached and shown as "no
      // servers" — a lie about the user's configuration for as long as the
      // entry lives.
      const { execFileFn } = fakeListing(null);

      await expect(
        new CursorAcpAdapter({ execFileFn }).listMcpServers({ cwd: '/proj' }),
      ).resolves.toEqual({
        ok: false,
        reason: expect.stringContaining('did not answer'),
      });
    });

    it('reports unreadable output as a FAILURE rather than an empty folder', async () => {
      // The case that matters most for this CLI: a cursor row has no
      // structural marker, so a reworded status makes the parser drop every
      // row. Without this branch that is indistinguishable from an empty
      // folder, and the panel would confidently say "No servers".
      const { execFileFn } = fakeListing('probe-good: online now\n');

      await expect(
        new CursorAcpAdapter({ execFileFn }).listMcpServers({ cwd: '/proj' }),
      ).resolves.toEqual({
        ok: false,
        reason: expect.stringContaining('format may have changed'),
      });
    });
  });
});

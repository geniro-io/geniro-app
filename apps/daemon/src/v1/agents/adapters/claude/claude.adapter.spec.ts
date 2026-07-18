import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
  captured: {
    command?: string;
    args?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  };
} {
  const child = new FakeChild();
  const captured: {
    command?: string;
    args?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {};
  const spawn: SpawnFn = (command, args, options) => {
    captured.command = command;
    captured.args = args;
    captured.cwd = options.cwd;
    captured.env = options.env;
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

  it('maps a successful result to turn_complete with usage, summing cache tokens into contextTokens', () => {
    expect(
      mapClaudeMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'pong',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 12,
          output_tokens: 3,
          // The bulk of a resumed session's context rides the cache counters —
          // contextTokens must include them, not just input_tokens.
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 900,
        },
        total_cost_usd: 0.14,
      }),
    ).toEqual([
      {
        type: 'turn_complete',
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          contextTokens: 1012,
          costUsd: 0.14,
        },
        stopReason: 'end_turn',
        finalText: 'pong',
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
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          contextTokens: 1,
          costUsd: 0.01,
        },
        stopReason: 'end_turn',
        finalText: 'hi',
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

describe('ClaudeAdapter approval seam (ask mode)', () => {
  const CONTROL_REQUEST =
    '{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"a.txt"}}}\n';

  it('maps a can_use_tool control_request to an approval_request event', () => {
    expect(mapClaudeMessage(JSON.parse(CONTROL_REQUEST))).toEqual([
      {
        type: 'approval_request',
        id: 'req-1',
        toolName: 'Write',
        input: { file_path: 'a.txt' },
      },
    ]);
  });

  it('carries requires_user_interaction — the question-vs-permission discriminator (M4)', () => {
    const events = mapClaudeMessage({
      type: 'control_request',
      request_id: 'req-q',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: { questions: [] },
        requires_user_interaction: true,
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'approval_request',
        toolName: 'AskUserQuestion',
        requiresUserInteraction: true,
      }),
    ]);
    // A plain permission carries no flag — the event must not fake one.
    const plain = mapClaudeMessage(JSON.parse(CONTROL_REQUEST));
    expect(
      (plain[0] as { requiresUserInteraction?: boolean })
        .requiresUserInteraction,
    ).toBeUndefined();
  });

  it('ignores control_requests that are not can_use_tool', () => {
    expect(
      mapClaudeMessage({
        type: 'control_request',
        request_id: 'r',
        request: { subtype: 'initialize' },
      }),
    ).toEqual([]);
  });

  it('adds the stdio permission flags in ask mode and none in plain chat', () => {
    const ask = fakeSpawn();
    new ClaudeAdapter({ spawn: ask.spawn }).start(
      { prompt: 'p', cwd: '/proj', approvalMode: 'ask' },
      () => {},
    );
    expect(ask.captured.args).toEqual(
      expect.arrayContaining([
        '--permission-mode',
        'default',
        '--permission-prompt-tool',
        'stdio',
      ]),
    );

    const plain = fakeSpawn();
    new ClaudeAdapter({ spawn: plain.spawn }).start(
      { prompt: 'p', cwd: '/proj' },
      () => {},
    );
    expect(plain.captured.args).not.toEqual(
      expect.arrayContaining(['--permission-prompt-tool']),
    );
    expect(plain.captured.args).not.toEqual(
      expect.arrayContaining(['--dangerously-skip-permissions']),
    );
  });

  it('bypasses permissions in auto mode and appends the system prompt', () => {
    const { spawn, captured } = fakeSpawn();
    new ClaudeAdapter({ spawn }).start(
      {
        prompt: 'p',
        cwd: '/proj',
        approvalMode: 'auto',
        systemPrompt: 'You are the reviewer.',
      },
      () => {},
    );
    expect(captured.args).toEqual(
      expect.arrayContaining(['--dangerously-skip-permissions']),
    );
    expect(captured.args).toEqual(
      expect.arrayContaining([
        '--append-system-prompt',
        'You are the reviewer.',
      ]),
    );
  });

  it('keeps stdin open in ask mode, answers via control_response, closes on the terminal event', async () => {
    const { spawn, child } = fakeSpawn();
    const endSpy = vi.spyOn(child.stdin, 'end');
    const events: AgentEvent[] = [];
    const handle = new ClaudeAdapter({ spawn }).start(
      { prompt: 'p', cwd: '/proj', approvalMode: 'ask' },
      (e) => events.push(e),
    );

    // Prompt written, stdin still open for the control dialogue.
    expect(child.stdin.written).toContain('"type":"user"');
    expect(endSpy).not.toHaveBeenCalled();

    child.stdout.emitData(CONTROL_REQUEST);
    expect(events.at(-1)).toMatchObject({
      type: 'approval_request',
      id: 'req-1',
    });

    handle.respondApproval('req-1', true, { file_path: 'a.txt' });
    const responseLine = child.stdin.written
      .split('\n')
      .filter(Boolean)
      .at(-1)!;
    expect(JSON.parse(responseLine)).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1',
        response: { behavior: 'allow', updatedInput: { file_path: 'a.txt' } },
      },
    });

    // Terminal result closes the kept-open stdin so the CLI can exit.
    child.stdout.emitData(
      '{"type":"result","is_error":false,"stop_reason":"end_turn"}\n',
    );
    expect(endSpy).toHaveBeenCalledOnce();
    child.emit('close', 0, null);
    await handle.done;
  });

  it('encodes a denial with behavior deny', async () => {
    const { spawn, child } = fakeSpawn();
    const handle = new ClaudeAdapter({ spawn }).start(
      { prompt: 'p', cwd: '/proj', approvalMode: 'ask' },
      () => {},
    );
    child.stdout.emitData(CONTROL_REQUEST);
    handle.respondApproval('req-1', false);
    const responseLine = child.stdin.written
      .split('\n')
      .filter(Boolean)
      .at(-1)!;
    expect(JSON.parse(responseLine).response.response.behavior).toBe('deny');
    child.emit('close', 0, null);
    await handle.done;
  });
});

describe('ClaudeAdapter binary override', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('spawns the GENIRO_CLAUDE_BIN override instead of the bare binary', () => {
    vi.stubEnv('GENIRO_CLAUDE_BIN', '/opt/tools/claude');
    const { spawn, captured } = fakeSpawn();
    new ClaudeAdapter({ spawn }).start({ prompt: 'p', cwd: '/proj' }, () => {});
    expect(captured.command).toBe('/opt/tools/claude');
  });
});

describe('ClaudeAdapter MCP config delivery (caller turns)', () => {
  const ENDPOINT = {
    url: 'http://127.0.0.1:4870/v1/mcp/run-1/orch',
    token: 'call-token-1',
  };
  const dirs: string[] = [];

  function mcpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'geniro-mcp-spec-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a per-turn 0600 config file, points argv at it, and injects MCP_TOOL_TIMEOUT', async () => {
    const { spawn, child, captured } = fakeSpawn();
    const dir = mcpDir();
    const handle = new ClaudeAdapter({ spawn, mcpConfigDir: dir }).start(
      { prompt: 'p', cwd: '/proj', mcpEndpoint: ENDPOINT },
      () => {},
    );
    const idx = captured.args!.indexOf('--mcp-config');
    expect(idx).toBeGreaterThan(-1);
    const configPath = captured.args![idx + 1]!;
    expect(captured.args).toContain('--strict-mcp-config');
    expect(configPath.startsWith(dir)).toBe(true);
    // The token travels IN the file (0600), never in argv.
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      mcpServers: {
        geniro: {
          type: 'http',
          url: ENDPOINT.url,
          headers: { Authorization: 'Bearer call-token-1' },
        },
      },
    });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(captured.args!.join(' ')).not.toContain('call-token-1');
    expect(captured.env?.MCP_TOOL_TIMEOUT).toBe(String(30 * 60_000));
    // The file dies with the turn.
    child.emit('close', 0, null);
    await handle.done;
    await new Promise((resolve) => setImmediate(resolve));
    expect(existsSync(configPath)).toBe(false);
  });

  it('disposes the config file when the turn settles via cancel, not just clean exit', async () => {
    const { spawn, child, captured } = fakeSpawn();
    const handle = new ClaudeAdapter({ spawn, mcpConfigDir: mcpDir() }).start(
      { prompt: 'p', cwd: '/proj', mcpEndpoint: ENDPOINT },
      () => {},
    );
    const idx = captured.args!.indexOf('--mcp-config');
    const configPath = captured.args![idx + 1]!;
    expect(existsSync(configPath)).toBe(true);
    // Cancel is a distinct settle path from a clean exit — the disposer must
    // run here too, or a live-token 0600 file leaks to tmp.
    handle.cancel();
    child.emit('close', null, 'SIGTERM');
    await handle.done;
    await new Promise((resolve) => setImmediate(resolve));
    expect(existsSync(configPath)).toBe(false);
  });

  it('honors a toolTimeoutMs override', () => {
    const { spawn, captured } = fakeSpawn();
    new ClaudeAdapter({ spawn, mcpConfigDir: mcpDir() }).start(
      {
        prompt: 'p',
        cwd: '/proj',
        mcpEndpoint: { ...ENDPOINT, toolTimeoutMs: 5000 },
      },
      () => {},
    );
    expect(captured.env?.MCP_TOOL_TIMEOUT).toBe('5000');
  });

  it('a turn without mcpEndpoint keeps argv and env untouched', () => {
    // "Untouched" means the ADAPTER adds nothing: the daemon's own process
    // env may legitimately carry MCP_TOOL_TIMEOUT (it does under some dev
    // harnesses), and runHeadlessCli passes the parent env through — so the
    // variable is scrubbed for this test or the assertion measures the
    // environment, not the adapter.
    const hadTimeout = Object.prototype.hasOwnProperty.call(
      process.env,
      'MCP_TOOL_TIMEOUT',
    );
    const previousTimeout = process.env.MCP_TOOL_TIMEOUT;
    delete process.env.MCP_TOOL_TIMEOUT;
    try {
      const { spawn, captured } = fakeSpawn();
      new ClaudeAdapter({ spawn, mcpConfigDir: mcpDir() }).start(
        { prompt: 'p', cwd: '/proj', env: { FOO: 'bar' } },
        () => {},
      );
      expect(captured.args!.join(' ')).not.toContain('--mcp-config');
      expect(captured.env?.MCP_TOOL_TIMEOUT).toBeUndefined();
      expect(captured.env?.FOO).toBe('bar');
    } finally {
      if (hadTimeout) {
        process.env.MCP_TOOL_TIMEOUT = previousTimeout;
      }
    }
  });
});

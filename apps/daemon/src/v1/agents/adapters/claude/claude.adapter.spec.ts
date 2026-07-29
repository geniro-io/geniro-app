import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SpawnedProcess, SpawnFn } from '../../utils/spawn-cli';
import type { AgentEvent, AgentTurnInput } from '../adapter.types';
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

  it('harvests init slash_commands alongside the session id, dropping non-strings', () => {
    expect(
      mapClaudeMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        slash_commands: ['review', 42, '', 'compact'],
      }),
    ).toEqual([
      { type: 'session', sessionId: 'sess-1' },
      { type: 'slash_commands', commands: ['review', 'compact'] },
    ]);
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

  it('maps a successful result to turn_complete with the usage readClaudeUsage derives', () => {
    expect(
      mapClaudeMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'pong',
        stop_reason: 'end_turn',
        usage: {
          // Turn-wide roll-up: three requests' worth of the same conversation.
          input_tokens: 12,
          output_tokens: 3,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 2_700,
          iterations: [
            {
              input_tokens: 4,
              output_tokens: 3,
              cache_creation_input_tokens: 12,
              cache_read_input_tokens: 996,
            },
          ],
        },
        modelUsage: {
          'claude-opus-5[1m]': {
            inputTokens: 12,
            cacheReadInputTokens: 2_700,
            contextWindow: 1_000_000,
          },
        },
        total_cost_usd: 0.14,
      }),
    ).toEqual([
      {
        type: 'turn_complete',
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          // The final request's prompt (4 + 12 + 996), not the 2_812 roll-up.
          contextTokens: 1012,
          contextWindowTokens: 1_000_000,
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
      '{"type":"result","is_error":false,"result":"hi","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1,"iterations":[{"input_tokens":1,"output_tokens":1}]},"total_cost_usd":0.01}\n',
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
          contextWindowTokens: null,
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

  it('maps acceptEdits and plan to their permission modes with the stdio prompt tool', () => {
    for (const mode of ['acceptEdits', 'plan'] as const) {
      const { spawn, captured } = fakeSpawn();
      new ClaudeAdapter({ spawn }).start(
        { prompt: 'p', cwd: '/proj', approvalMode: mode },
        () => {},
      );
      expect(captured.args).toEqual(
        expect.arrayContaining([
          '--permission-mode',
          mode,
          '--permission-prompt-tool',
          'stdio',
        ]),
      );
      expect(captured.args).not.toEqual(
        expect.arrayContaining(['--dangerously-skip-permissions']),
      );
    }
  });

  it('keeps stdin open for the acceptEdits and plan stdio-dialogue modes', () => {
    for (const mode of ['acceptEdits', 'plan'] as const) {
      const { spawn, child } = fakeSpawn();
      const endSpy = vi.spyOn(child.stdin, 'end');
      new ClaudeAdapter({ spawn }).start(
        { prompt: 'p', cwd: '/proj', approvalMode: mode },
        () => {},
      );
      expect(child.stdin.written).toContain('"type":"user"');
      expect(endSpy).not.toHaveBeenCalled();
    }
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

  it('gives an auto turn the stdio dialogue when it must be able to ask the user', () => {
    // --dangerously-skip-permissions STRIPS AskUserQuestion (probe-verified),
    // so an auto turn that wants the question channel spawns on the dialogue
    // instead. The daemon then stands in for the bypass at its approval seam.
    const { spawn, captured, child } = fakeSpawn();
    const endSpy = vi.spyOn(child.stdin, 'end');
    new ClaudeAdapter({ spawn }).start(
      {
        prompt: 'p',
        cwd: '/proj',
        approvalMode: 'auto',
        allowUserQuestions: true,
      },
      () => {},
    );

    expect(captured.args).not.toContain('--dangerously-skip-permissions');
    expect(captured.args).toEqual(
      expect.arrayContaining([
        '--permission-mode',
        'default',
        '--permission-prompt-tool',
        'stdio',
      ]),
    );
    // The verdict needs a way back in, so stdin must NOT close after the prompt.
    expect(endSpy).not.toHaveBeenCalled();
  });

  it('still bypasses permissions for an auto turn that will not ask', () => {
    // The reversion pin for the branch above — and the stdin half the older
    // auto-mode argv test never asserted.
    const { spawn, captured, child } = fakeSpawn();
    const endSpy = vi.spyOn(child.stdin, 'end');
    new ClaudeAdapter({ spawn }).start(
      { prompt: 'p', cwd: '/proj', approvalMode: 'auto' },
      () => {},
    );

    expect(captured.args).toContain('--dangerously-skip-permissions');
    expect(captured.args).not.toContain('--permission-prompt-tool');
    expect(endSpy).toHaveBeenCalled();
  });

  it('leaves a legacy turn (no approval mode) byte-identical when asking is allowed', () => {
    // A pre-selector chat row carries no mode: it must keep the CLI's own
    // defaults and no permission flags, even though every chat now asks for
    // the question channel.
    const plain = fakeSpawn();
    new ClaudeAdapter({ spawn: plain.spawn }).start(
      { prompt: 'p', cwd: '/proj' },
      () => {},
    );
    const asking = fakeSpawn();
    const endSpy = vi.spyOn(asking.child.stdin, 'end');
    new ClaudeAdapter({ spawn: asking.spawn }).start(
      { prompt: 'p', cwd: '/proj', allowUserQuestions: true },
      () => {},
    );

    expect(asking.captured.args).toEqual(plain.captured.args);
    expect(asking.captured.args).not.toContain('--permission-mode');
    expect(endSpy).toHaveBeenCalled();
  });

  it('reports the tool it asks the user with, so no service spells the name', () => {
    expect(new ClaudeAdapter().questionToolName).toBe('AskUserQuestion');
  });

  it('asks for token-level output only when the turn wants it', () => {
    const off = fakeSpawn();
    new ClaudeAdapter({ spawn: off.spawn }).start(
      { prompt: 'p', cwd: '/proj' },
      () => {},
    );
    const on = fakeSpawn();
    new ClaudeAdapter({ spawn: on.spawn }).start(
      { prompt: 'p', cwd: '/proj', streamPartials: true },
      () => {},
    );

    expect(off.captured.args).not.toContain('--include-partial-messages');
    expect(on.captured.args).toContain('--include-partial-messages');
  });

  it('turns a stream_event into a live text increment, never a message', () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    new ClaudeAdapter({ spawn }).start(
      { prompt: 'p', cwd: '/proj', streamPartials: true },
      (e) => events.push(e),
    );

    child.stdout.emitData(
      `${JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'The sea' },
        },
      })}\n`,
    );

    expect(events).toEqual([{ type: 'text_delta', text: 'The sea' }]);
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

  /** Wraps the real prepareTurn disposer so a spec can observe it ran exactly once. */
  class DisposerCountingAdapter extends ClaudeAdapter {
    disposeCalls = 0;
    protected override prepareTurn(
      input: AgentTurnInput,
    ): (() => void) | undefined {
      const dispose = super.prepareTurn(input);
      return dispose
        ? () => {
            this.disposeCalls += 1;
            dispose();
          }
        : undefined;
    }
  }

  /** Throws between prepareTurn and the spawn — the base start()'s "bad argv" catch path. */
  class ThrowingArgsAdapter extends DisposerCountingAdapter {
    protected override buildArgs(): string[] {
      throw new Error('bad argv');
    }
  }

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

  it('disposes the config exactly once when the spawn throws (settled-handle path)', async () => {
    // runHeadlessCli absorbs a throwing SpawnFn into the handle contract: the
    // failure surfaces as an error event and `done` is already resolved — the
    // disposer must still ride that settled handle, or a spawn failure (bad
    // binary path, EACCES) leaks the live-token 0600 file to tmp.
    const dir = mcpDir();
    const events: AgentEvent[] = [];
    let spawnArgs: string[] | undefined;
    const spawn: SpawnFn = (_command, args) => {
      spawnArgs = args;
      throw new Error('EACCES');
    };
    const adapter = new DisposerCountingAdapter({ spawn, mcpConfigDir: dir });

    const handle = adapter.start(
      { prompt: 'p', cwd: '/proj', mcpEndpoint: ENDPOINT },
      (e) => events.push(e),
    );

    expect(events).toEqual([
      { type: 'error', message: expect.stringContaining('failed to spawn') },
    ]);
    const idx = spawnArgs!.indexOf('--mcp-config');
    expect(idx).toBeGreaterThan(-1);
    const configPath = spawnArgs![idx + 1]!;
    // The disposer rides `done` as a microtask — still present synchronously,
    // gone once the settled handle's callback has run.
    expect(existsSync(configPath)).toBe(true);
    await handle.done;
    await new Promise((resolve) => setImmediate(resolve));
    expect(existsSync(configPath)).toBe(false);
    expect(adapter.disposeCalls).toBe(1);
  });

  it('a synchronous throw between prepareTurn and the handle disposes then rethrows', () => {
    // The base start()'s catch branch (agent-adapter.ts): no handle ever
    // exists, so without the catch's dispose the written config file would
    // leak with a green suite. buildArgs throwing is the documented "bad
    // argv" entry into that branch.
    const dir = mcpDir();
    const adapter = new ThrowingArgsAdapter({
      spawn: fakeSpawn().spawn,
      mcpConfigDir: dir,
    });

    expect(() =>
      adapter.start(
        { prompt: 'p', cwd: '/proj', mcpEndpoint: ENDPOINT },
        () => {},
      ),
    ).toThrow('bad argv');

    // prepareTurn wrote the file before the throw; the catch removed it.
    expect(readdirSync(dir)).toEqual([]);
    expect(adapter.disposeCalls).toBe(1);
  });

  /** A disposer that itself throws AFTER real cleanup — the rmSync-EACCES shape. */
  class ThrowingDisposerAdapter extends ClaudeAdapter {
    protected override prepareTurn(
      input: AgentTurnInput,
    ): (() => void) | undefined {
      const dispose = super.prepareTurn(input);
      return () => {
        dispose?.();
        throw new Error('EACCES: rm failed');
      };
    }
  }

  it('a throwing disposer on settle is logged as a warning, never an unhandled rejection', async () => {
    const warn = vi.fn();
    const { spawn, child } = fakeSpawn();
    const handle = new ThrowingDisposerAdapter({
      spawn,
      mcpConfigDir: mcpDir(),
      logger: { warn },
    }).start({ prompt: 'p', cwd: '/proj', mcpEndpoint: ENDPOINT }, () => {});

    child.emit('close', 0, null);
    await handle.done;
    await new Promise((resolve) => setImmediate(resolve));

    // The guard exists so cleanup failure cannot reject the settle chain —
    // deleting the catch would make this an unhandled rejection instead.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('disposer failed'),
    );
  });

  it('a throwing disposer in the sync-throw catch never masks the original error', () => {
    class ThrowingBothAdapter extends ThrowingDisposerAdapter {
      protected override buildArgs(): string[] {
        throw new Error('bad argv');
      }
    }
    const warn = vi.fn();
    const adapter = new ThrowingBothAdapter({
      spawn: fakeSpawn().spawn,
      mcpConfigDir: mcpDir(),
      logger: { warn },
    });

    // The ORIGINAL error propagates; the cleanup failure is only logged.
    expect(() =>
      adapter.start(
        { prompt: 'p', cwd: '/proj', mcpEndpoint: ENDPOINT },
        () => {},
      ),
    ).toThrow('bad argv');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('disposer failed'),
    );
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

describe('ClaudeAdapter image attachments', () => {
  it('sends attached images as base64 content blocks, ahead of the text', () => {
    // The CLI's stream-json input takes Messages-API content blocks, so an
    // image reaches the model directly — probe-verified against claude 2.1.220
    // in July 2026 (it described a magenta probe image without a tool call).
    // Handing over a path instead would cost a Read round-trip and put the
    // image behind the permission gate.
    const dir = mkdtempSync(join(tmpdir(), 'claude-images-'));
    const path = join(dir, 'shot.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(path, bytes);
    const { spawn, child } = fakeSpawn();
    const adapter = new ClaudeAdapter({ spawn });

    try {
      adapter.start(
        {
          prompt: 'what is wrong here?',
          cwd: dir,
          images: [{ path, mediaType: 'image/png' }],
        },
        () => {},
      );

      const payload = JSON.parse(child.stdin.written) as {
        message: { content: { type: string; source?: { data: string } }[] };
      };
      expect(payload.message.content.map((block) => block.type)).toEqual([
        'image',
        'text',
      ]);
      expect(payload.message.content[0]?.source?.data).toBe(
        bytes.toString('base64'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends a text-only turn as a lone text block', () => {
    const { spawn, child } = fakeSpawn();
    const adapter = new ClaudeAdapter({ spawn });

    adapter.start({ prompt: 'hello', cwd: tmpdir() }, () => {});

    const payload = JSON.parse(child.stdin.written) as {
      message: { content: { type: string }[] };
    };
    expect(payload.message.content).toEqual([{ type: 'text', text: 'hello' }]);
  });
});

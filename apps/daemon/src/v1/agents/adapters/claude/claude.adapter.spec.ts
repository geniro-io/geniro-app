import type { ChildProcess, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeModesCapability } from '../../chat.types';
import type { SpawnedProcess, SpawnFn } from '../../utils/spawn-cli';
import type {
  AdapterConfig,
  AgentEvent,
  AgentTurnHandle,
  AgentTurnInput,
} from '../adapter.types';
import { ClaudeAdapter } from './claude.adapter';
import {
  CLAUDE_BASE_ARGS,
  CLAUDE_COMMANDS_PROBE_PROMPT,
  CLAUDE_CONFIG,
  CLAUDE_MAX_REPORTED_COMMANDS,
  CLAUDE_RESUME_FLAG,
} from './claude.const';

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
  kills = 0;
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killSignal = signal;
    this.kills += 1;
    return true;
  }
}

/**
 * A child that DIES when signalled, the way a real CLI does: `close` follows
 * the SIGTERM. The command probe cancels its own turn and then awaits `done`,
 * so a fake that swallowed the kill would hang the read instead of testing it.
 */
class KillableChild extends FakeChild {
  override kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    super.kill(signal);
    // A real child's `close` lands after the signal, never within it.
    setTimeout(() => this.emit('close', null, signal), 0);
    return true;
  }
}

function fakeSpawn<C extends FakeChild = FakeChild>(
  child: C = new FakeChild() as C,
): {
  spawn: SpawnFn;
  child: C;
  captured: {
    command?: string;
    args?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  };
} {
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

  it('passes --effort only when the turn names a level', () => {
    const withEffort = fakeSpawn();
    new ClaudeAdapter({ spawn: withEffort.spawn }).start(
      { prompt: 'go', cwd: '/proj', effort: 'ultracode' },
      () => {},
    );
    expect(withEffort.captured.args).toEqual(
      expect.arrayContaining(['--effort', 'ultracode']),
    );

    const without = fakeSpawn();
    new ClaudeAdapter({ spawn: without.spawn }).start(
      { prompt: 'go', cwd: '/proj' },
      () => {},
    );
    expect(without.captured.args).not.toContain('--effort');
  });

  it('lists exactly the probe-verified effort vocabulary, ultracode included', () => {
    const levels = new ClaudeAdapter().listEfforts().map((e) => e.id);
    // `--help` names only the first five; ultracode is accepted but
    // undocumented, so a list scraped from help output would be missing it.
    expect(levels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ]);
    // A rejected value the CLI warns about must never be offered.
    expect(levels).not.toContain('ultrathink');
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

  it('logs the unmodelled subtype from the base class and keeps it off the turn', () => {
    // The mapper hands it back; `AgentAdapter.start` is the one caller that
    // logs it. It must NOT reach the consumer — a diagnostic is not an event.
    const warnings: string[] = [];
    const fake = fakeSpawn();
    const seen: AgentEvent[] = [];
    new ClaudeAdapter({
      spawn: fake.spawn,
      logger: { warn: (m) => warnings.push(m) },
    }).start({ prompt: 'p', cwd: '/proj' }, (event) => seen.push(event));
    fake.child.stdout.emitData(
      '{"type":"control_request","request_id":"r","request":{"subtype":"initialize"}}\n',
    );
    expect(seen).toEqual([]);
    expect(warnings).toEqual([
      "claude: unmodelled control_request subtype 'initialize' — dropped",
    ]);
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
    expect(new ClaudeAdapter().config.questionToolName).toBe('AskUserQuestion');
  });

  it('degrades a PROVEN-unsupported acceptEdits to ask, and says so', () => {
    const resolved = new ClaudeAdapter().resolveApprovalMode('acceptEdits', {
      supported: { acceptEdits: false },
    });
    expect(resolved.mode).toBe('ask');
    expect(resolved.degradeReason).toContain('does not support acceptEdits');
  });

  it('keeps an UNPROBED acceptEdits, so a real rejection comes from the CLI', () => {
    // Absent ≠ false: nobody asked this binary, so degrading here would
    // pre-empt the CLI's own answer on a guess.
    const resolved = new ClaudeAdapter().resolveApprovalMode('acceptEdits', {
      supported: {},
    });
    expect(resolved).toEqual({ mode: 'acceptEdits', degradeReason: null });
  });

  it('never degrades plan — an executing fallback would invert what it promises', () => {
    // `plan` is probed exactly like acceptEdits, and a FAIL still must not turn
    // a no-execute mode into an executing 'ask'.
    const resolved = new ClaudeAdapter().resolveApprovalMode('plan', {
      supported: { plan: false },
    });
    expect(resolved).toEqual({ mode: 'plan', degradeReason: null });
  });

  it('declares the modes it honours, which of them are empirical, and how calls reach it', () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.config.approval.modes).toEqual([
      'auto',
      'ask',
      'acceptEdits',
      'plan',
    ]);
    // Only these two cost a run a probe turn — the pair `approvalSupportFrom`
    // translates out of the capability bag.
    expect(adapter.config.approval.probedModes).toEqual([
      'acceptEdits',
      'plan',
    ]);
    // The endpoint rides --mcp-config per turn: no machine trust to establish,
    // and nothing written into the user's cwd.
    expect(adapter.config.mcp.callToolsRequireTrustProbe).toBe(false);
    expect(adapter.config.mcp.endpointRequiresCwdConfig).toBe(false);
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

describe('ClaudeAdapter — installed approval support', () => {
  function verdict(
    overrides: Partial<ClaudeModesCapability> = {},
  ): ClaudeModesCapability {
    return {
      acceptEdits: 'unknown',
      plan: 'unknown',
      version: null,
      probedAt: null,
      reason: null,
      ...overrides,
    };
  }

  it('maps an unprobed mode to ABSENT, never to false', () => {
    // The distinction the whole degrade rests on: `false` means "proved
    // rejected" and degrades the turn, while absent means "nobody asked" and
    // must leave the requested mode alone. Collapsing `unknown` into `false`
    // would silently downgrade every turn on a machine that has not probed yet.
    const support = new ClaudeAdapter().approvalSupportFrom({
      claudeModes: verdict(),
    });
    expect(support.supported).toEqual({});
    expect('acceptEdits' in support.supported).toBe(false);
  });

  it('maps a pass to true and a fail to false, per mode', () => {
    expect(
      new ClaudeAdapter().approvalSupportFrom({
        claudeModes: verdict({ acceptEdits: 'fail', plan: 'pass' }),
      }).supported,
    ).toEqual({ acceptEdits: false, plan: true });
  });

  it('carries only the probed modes — nothing is invented for the rest', () => {
    const support = new ClaudeAdapter().approvalSupportFrom({
      claudeModes: verdict({ acceptEdits: 'pass', plan: 'fail' }),
    });
    expect(Object.keys(support.supported).sort()).toEqual([
      'acceptEdits',
      'plan',
    ]);
  });
});

describe('ClaudeAdapter — the AskUserQuestion channel', () => {
  const QUESTION_INPUT = {
    questions: [
      {
        question: 'Which color?',
        header: 'Color',
        options: [{ label: 'Red' }, { label: 'Blue' }],
      },
    ],
  };

  it('projects the tool input into the CLI-agnostic question shape', () => {
    // The consumers (the graph executor's Q&A bridge) hold this projection,
    // never claude's payload — so the header qualification and the FLAT option
    // list are the adapter's promise, not the executor's.
    expect(new ClaudeAdapter().questionFrom(QUESTION_INPUT)).toEqual({
      text: '[Color] Which color?',
      options: ['Red', 'Blue'],
    });
  });

  it('folds an answer into the tool input as AskUserQuestion `response`', () => {
    // The probe-verified free-text channel: the answer must ride INSIDE the
    // tool input claude gets back, with the questions left intact.
    expect(new ClaudeAdapter().withAnswer(QUESTION_INPUT, 'Blue')).toEqual({
      ...QUESTION_INPUT,
      response: 'Blue',
    });
  });
});

describe('ClaudeAdapter — skills and commands on disk', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function writeSkill(root: string, name: string, frontmatter: string): void {
    const dir = join(root, '.claude', 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\nBody.\n`);
  }

  function writeCommand(root: string, relPath: string, content: string): void {
    const path = join(root, '.claude', 'commands', relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  function build(): { cwd: string; homeDir: string } {
    return { cwd: tempDir('claude-cwd-'), homeDir: tempDir('claude-home-') };
  }

  it('scans skills and commands from the project folder and from ~', async () => {
    const { cwd, homeDir } = build();
    writeSkill(cwd, 'deploy', 'name: deploy\ndescription: Ship it');
    writeCommand(cwd, 'review.md', '---\ndescription: Review\n---\n');
    writeSkill(homeDir, 'zsh-help', 'description: Home skill');
    writeCommand(homeDir, 'auth.md', 'Check auth flows.');

    expect(await new ClaudeAdapter().listSkills({ cwd, homeDir })).toEqual([
      {
        name: 'deploy',
        description: 'Ship it',
        kind: 'skill',
        source: 'project',
      },
      {
        name: 'review',
        description: 'Review',
        kind: 'command',
        source: 'project',
      },
      {
        name: 'zsh-help',
        description: 'Home skill',
        kind: 'skill',
        source: 'user',
      },
      {
        name: 'auth',
        description: 'Check auth flows.',
        kind: 'command',
        source: 'user',
      },
    ]);
  });

  it('returns project before user, and a skill before a same-named command', async () => {
    // The ORDER is the contract: the caller de-dupes first-occurrence-wins, so
    // this is what makes it keep the entry claude would actually run. The base
    // reproduces it by iterating roots outer, skills-then-commands inner.
    const { cwd, homeDir } = build();
    writeSkill(cwd, 'deploy', 'name: deploy\ndescription: Project skill');
    writeCommand(cwd, 'deploy.md', '---\ndescription: Project command\n---\n');
    writeSkill(homeDir, 'deploy', 'name: deploy\ndescription: User skill');

    const found = await new ClaudeAdapter().listSkills({ cwd, homeDir });
    expect(found.map((entry) => entry.description)).toEqual([
      'Project skill',
      'Project command',
      'User skill',
    ]);
  });

  it('returns [] when no skill/command directories exist at all', async () => {
    const { cwd, homeDir } = build();
    await expect(
      new ClaudeAdapter().listSkills({ cwd, homeDir }),
    ).resolves.toEqual([]);
  });

  it('never reads cursor-agent roots', async () => {
    const { cwd, homeDir } = build();
    mkdirSync(join(cwd, '.cursor', 'commands'), { recursive: true });
    writeFileSync(join(cwd, '.cursor', 'commands', 'fix.md'), 'Fix it.');

    await expect(
      new ClaudeAdapter().listSkills({ cwd, homeDir }),
    ).resolves.toEqual([]);
  });
});

describe('ClaudeAdapter — live (token-level) stream support', () => {
  /** Answers the utility command with canned stdout, capturing its argv. */
  function fakeHelp(stdout: string | null): {
    execFileFn: typeof execFile;
    captured: { args?: readonly string[]; calls: number };
  } {
    const captured: { args?: readonly string[]; calls: number } = { calls: 0 };
    const execFileFn = ((
      _cmd: string,
      args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, out: string) => void,
    ) => {
      captured.args = args;
      captured.calls += 1;
      cb(stdout === null ? new Error('spawn failed') : null, stdout ?? '');
      return {} as ChildProcess;
    }) as unknown as typeof execFile;
    return { execFileFn, captured };
  }

  it('reads support off the binary that would reject the flag', async () => {
    // `--help` is the cheapest honest source: same binary, no account, no turn.
    const { execFileFn, captured } = fakeHelp(
      '  --verbose\n  --include-partial-messages   Include partial message chunks\n',
    );

    await expect(
      new ClaudeAdapter({ execFileFn }).supportsLiveStream(),
    ).resolves.toBe(true);
    expect(captured.args).toEqual(['--help']);
  });

  it('answers NO for an older CLI, so turns degrade to block streaming', async () => {
    // The whole point of asking: passing the flag to a CLI that does not know
    // it fails every turn on argv, which is far worse than not streaming.
    const { execFileFn } = fakeHelp('  --verbose\n  --model\n');

    await expect(
      new ClaudeAdapter({ execFileFn }).supportsLiveStream(),
    ).resolves.toBe(false);
  });

  it('answers NO when the binary could not be asked at all, and asks once', async () => {
    const { execFileFn, captured } = fakeHelp(null);
    const adapter = new ClaudeAdapter({ execFileFn });

    await expect(adapter.supportsLiveStream()).resolves.toBe(false);
    // Memoized per adapter instance: a second turn must not re-spawn --help.
    await expect(adapter.supportsLiveStream()).resolves.toBe(false);
    expect(captured.calls).toBe(1);
  });
});

describe('ClaudeAdapter — commands the CLI reports about itself', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  /** The `system/init` line the CLI reports its invokable set on. */
  function initLine(commands: string[]): string {
    return `${JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'probe-1',
      slash_commands: commands,
    })}\n`;
  }

  /** A killable child plus what the probe turn was spawned with. */
  function probeSpawn(): {
    spawn: SpawnFn;
    child: KillableChild;
    captured: { command?: string; args?: string[]; cwd?: string };
    cwdExistedDuringTurn: () => boolean;
  } {
    const inner = fakeSpawn(new KillableChild());
    let existed = false;
    const spawn: SpawnFn = (command, args, options) => {
      existed = existsSync(options.cwd);
      return inner.spawn(command, args, options);
    };
    return {
      spawn,
      child: inner.child,
      captured: inner.captured,
      cwdExistedDuringTurn: () => existed,
    };
  }

  it('returns the commands the CLI reported about itself', async () => {
    const { spawn, child } = probeSpawn();
    const reported = new ClaudeAdapter({
      spawn,
      probeRootDir: tempDir('probe-root-'),
    }).listReportedCommands();

    child.stdout.emitData(initLine(['clear', 'compact', 'geniro:review']));

    await expect(reported).resolves.toEqual([
      'clear',
      'compact',
      'geniro:review',
    ]);
  });

  it("drops claude's internal `_`-prefixed commands", async () => {
    // `__remote-workflow` is reported but is not something a user invokes —
    // offering it in the autocomplete would be a dead row.
    const { spawn, child } = probeSpawn();
    const reported = new ClaudeAdapter({
      spawn,
      probeRootDir: tempDir('probe-root-'),
    }).listReportedCommands();

    child.stdout.emitData(
      initLine(['clear', '__remote-workflow', '_hidden', 'compact']),
    );

    await expect(reported).resolves.toEqual(['clear', 'compact']);
  });

  it('caps the reported list, however much the CLI claims', async () => {
    // A defensive bound: init reports ~60 entries today, and an autocomplete
    // is not the place to discover that a plugin registered thousands.
    const { spawn, child } = probeSpawn();
    const reported = new ClaudeAdapter({
      spawn,
      probeRootDir: tempDir('probe-root-'),
    }).listReportedCommands();

    child.stdout.emitData(
      initLine(
        Array.from(
          { length: CLAUDE_MAX_REPORTED_COMMANDS + 100 },
          (_, i) => `cmd-${i}`,
        ),
      ),
    );

    await expect(reported).resolves.toHaveLength(CLAUDE_MAX_REPORTED_COMMANDS);
  });

  it('cancels the turn the moment the list lands, before the model runs', async () => {
    // The whole point of probing this way: init carries the list, so paying
    // for the rest of the turn buys nothing.
    const { spawn, child } = probeSpawn();
    const reported = new ClaudeAdapter({
      spawn,
      probeRootDir: tempDir('probe-root-'),
    }).listReportedCommands();

    child.stdout.emitData(initLine(['clear']));
    await reported;

    expect(child.kills).toBe(1);
    expect(child.killSignal).toBe('SIGTERM');
  });

  it('runs in a throwaway workspace under the given root, and removes it', async () => {
    const probeRootDir = tempDir('probe-root-');
    const { spawn, child, captured, cwdExistedDuringTurn } = probeSpawn();
    const reported = new ClaudeAdapter({
      spawn,
      probeRootDir,
    }).listReportedCommands();

    child.stdout.emitData(initLine(['clear']));
    await reported;

    const cwd = captured.cwd ?? '';
    expect(cwd.startsWith(probeRootDir)).toBe(true);
    expect(cwdExistedDuringTurn()).toBe(true);
    expect(existsSync(cwd)).toBe(false);
    expect(readdirSync(probeRootDir)).toEqual([]);
  });

  it('runs the least-privileged turn — no permission bypass, no MCP endpoint', async () => {
    // The probe never reaches a tool, so it asks for nothing that would let it:
    // the argv is the plain stream-json head, and the prompt is the config's.
    const { spawn, child, captured } = probeSpawn();
    const reported = new ClaudeAdapter({
      spawn,
      probeRootDir: tempDir('probe-root-'),
    }).listReportedCommands();

    child.stdout.emitData(initLine(['clear']));
    await reported;

    expect(captured.args).toEqual([...CLAUDE_BASE_ARGS]);
    expect(captured.args).not.toContain('--dangerously-skip-permissions');
    expect(captured.args).not.toContain('--permission-mode');
    expect(captured.args).not.toContain('--mcp-config');
    expect(JSON.parse(child.stdin.written.trim())).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: CLAUDE_COMMANDS_PROBE_PROMPT }],
      },
    });
  });

  it('reports nothing when the CLI exits before its init line', async () => {
    // A missing binary or a failed sign-in ends the turn with no report; the
    // caller falls back to the disk scan rather than surfacing an error.
    const { spawn, child } = probeSpawn();
    const reported = new ClaudeAdapter({
      spawn,
      probeRootDir: tempDir('probe-root-'),
    }).listReportedCommands();

    child.emit('close', 0, null);

    await expect(reported).resolves.toEqual([]);
  });

  it('reports nothing when the CLI cannot be spawned at all', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('spawn ENOENT');
    };

    await expect(
      new ClaudeAdapter({
        spawn,
        probeRootDir: tempDir('probe-root-'),
      }).listReportedCommands(),
    ).resolves.toEqual([]);
  });

  it('reports nothing when the probe workspace cannot even be created', async () => {
    // Enters the probe's own catch: a probeRootDir that is a FILE makes the
    // mkdir throw before any turn exists. Without a test that reaches it, a
    // later "dead code" sweep deletes the guard and the read starts throwing
    // at the composer instead of degrading to the disk scan.
    const root = join(tempDir('probe-root-'), 'not-a-dir');
    writeFileSync(root, 'file, not a directory');
    const { spawn } = probeSpawn();

    await expect(
      new ClaudeAdapter({ spawn, probeRootDir: root }).listReportedCommands(),
    ).resolves.toEqual([]);
  });

  it('gives up on a turn that never reports, rather than hanging forever', async () => {
    // A CLI that dropped into an interactive login holds the turn open; the
    // timeout must cancel it so the autocomplete read still completes.
    const { spawn, child } = probeSpawn();

    await expect(
      new ClaudeAdapter({
        spawn,
        probeRootDir: tempDir('probe-root-'),
      }).listReportedCommands({ timeoutMs: 10 }),
    ).resolves.toEqual([]);
    expect(child.kills).toBe(1);
  });

  it('hands the turn to onTurn so it can be reaped on shutdown', async () => {
    // Every child the daemon spawns must be registered — a probe turn is no
    // exception, and start() hands back a handle rather than a child.
    const { spawn, child } = probeSpawn();
    const registered: AgentTurnHandle[] = [];
    const reported = new ClaudeAdapter({
      spawn,
      probeRootDir: tempDir('probe-root-'),
    }).listReportedCommands({ onTurn: (handle) => registered.push(handle) });

    child.stdout.emitData(initLine(['clear']));
    await reported;

    expect(registered.length).toBe(1);
  });
});

describe('ClaudeAdapter — the interactive terminal mirror', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resumes the stored claude session', () => {
    expect(new ClaudeAdapter().terminalCommand('sess-42')).toEqual({
      ok: true,
      command: 'claude',
      args: [CLAUDE_RESUME_FLAG, 'sess-42'],
    });
  });

  it('refuses with no-session until a resumable session id is stored', () => {
    // Not a mirror target: launching the TUI without a resume id would open an
    // unrelated fresh conversation while claiming to show the run's own.
    expect(new ClaudeAdapter().terminalCommand(null)).toEqual({
      ok: false,
      reason: 'no-session',
    });
  });

  it('refuses a whitespace-only session id instead of building a broken resume argv', () => {
    expect(new ClaudeAdapter().terminalCommand(' \t\n ')).toEqual({
      ok: false,
      reason: 'no-session',
    });
  });

  it('refuses a zero-width-only session id instead of an invisible resume target', () => {
    // U+200B is not trimmed as whitespace, so only the id PATTERN rejects it.
    expect(new ClaudeAdapter().terminalCommand('\u200b')).toEqual({
      ok: false,
      reason: 'no-session',
    });
  });

  it('mirrors through the GENIRO_CLAUDE_BIN override path', () => {
    // The mirror spawns the same binary a turn would — resolved per access, so
    // a Settings cliPaths override reaches the TUI too.
    vi.stubEnv('GENIRO_CLAUDE_BIN', '/opt/tools/claude');
    expect(new ClaudeAdapter().terminalCommand('sess-42')).toEqual({
      ok: true,
      command: '/opt/tools/claude',
      args: [CLAUDE_RESUME_FLAG, 'sess-42'],
    });
  });
});

describe('ClaudeAdapter — models', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop() as string, { recursive: true, force: true });
    }
  });

  function emptyHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'claude-no-cache-'));
    dirs.push(dir);
    return dir;
  }

  it('floors the picker with the set its CONFIG declares, not the shipped const', async () => {
    // `config.builtinModels` is documented as THE fallback contract — "what a
    // CLI that cannot be asked answers with so the picker is never empty" — so
    // it must be what listModels actually reads. An adapter whose config
    // carries a different floor answers with THAT floor; reaching past config
    // to CLAUDE_BUILTIN_MODELS would leave the field write-only, and this test
    // is the thing that fails when someone does.
    class ConfiguredClaudeAdapter extends ClaudeAdapter {
      override readonly config: AdapterConfig = {
        ...CLAUDE_CONFIG,
        builtinModels: [
          {
            id: 'pinned-floor-model',
            label: 'Pinned floor',
            source: 'builtin',
          },
        ],
      };
    }

    const models = await new ConfiguredClaudeAdapter({
      homeDir: emptyHome(),
    }).listModels();

    expect(models).toEqual([
      { id: 'pinned-floor-model', label: 'Pinned floor', source: 'builtin' },
    ]);
  });

  it('offers the shipped aliases as the floor of a stock adapter', async () => {
    // The other half: the config the adapter actually ships must carry the
    // documented tier aliases, so a real install's picker is never empty.
    const models = await new ClaudeAdapter({
      homeDir: emptyHome(),
    }).listModels();

    expect(models.map((model) => model.id)).toEqual([
      'opus',
      'sonnet',
      'haiku',
    ]);
  });
});

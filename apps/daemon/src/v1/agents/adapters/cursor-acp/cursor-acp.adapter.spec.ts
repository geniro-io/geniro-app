import type { ChildProcess, execFile, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeChild, fakeSpawn } from '../../__tests__/fake-child';
import { GENIRO_UI_PREAMBLE } from '../../utils/agent-instructions';
import type { SpawnedProcess, SpawnFn } from '../../utils/spawn-cli';
import { fakeGroupChild } from '../__tests__/fake-group-child';
import type { AcpToolCall } from '../acp/acp.types';
import type {
  AdapterConfig,
  AgentEvent,
  AgentTurnInput,
} from '../adapter.types';
import { CursorAcpAdapter, cursorAutoDecision } from './cursor-acp.adapter';
import {
  CURSOR_ACP_SESSIONS_DIR_NAME,
  CURSOR_HOME_DIR_NAME,
  CURSOR_SESSION_MISSING_MESSAGE,
  CURSOR_SILENTLY_DECLINED_METHODS,
} from './cursor-acp.const';

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

/** Per-turn profile dirs this spec created, removed after each case. */
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.GENIRO_CURSOR_API_KEY;
  // The adapter now sources the user's OWN inherited key, so a test that sets
  // it would otherwise leak into every later case's child env.
  delete process.env.CURSOR_API_KEY;
  delete process.env.GENIRO_CURSOR_BIN;
});

/**
 * Answers a utility command (`runCommand`, not `start`) with canned stdout,
 * capturing its argv and options. A turn is spawned through `spawn`;
 * everything else runs through `execFileFn`. A null stdout is the
 * command-failed signal — `runCommand` swallows the error and returns null.
 */
function fakeListing(stdout: string | null): {
  groupSpawnFn: typeof spawn;
  captured: {
    args?: readonly string[];
    opts?: { cwd?: string; detached?: boolean; env?: NodeJS.ProcessEnv };
  };
} {
  const captured: {
    args?: readonly string[];
    opts?: { cwd?: string; detached?: boolean; env?: NodeJS.ProcessEnv };
  } = {};
  const groupSpawnFn = ((
    _command: string,
    args: readonly string[],
    opts: { cwd?: string; detached?: boolean; env?: NodeJS.ProcessEnv },
  ) => {
    captured.args = args;
    captured.opts = opts;
    const fake = fakeGroupChild(4242);
    queueMicrotask(() => {
      // A null stdout is the could-not-be-run signal: the CLI is missing, or
      // it exited non-zero. `spawn` reports that as the exit status rather
      // than as an error argument, so the double has to as well.
      if (stdout === null) {
        fake.close(1);
        return;
      }
      fake.writeStdout(stdout);
      fake.close(0);
    });
    return fake.child;
  }) as unknown as typeof spawn;
  return { groupSpawnFn, captured };
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
        mcpEndpoint: {
          url: 'http://127.0.0.1:9/mcp',
          token: 'secret-token',
          serverName: 'geniro-run-1',
        },
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

  it('does not re-introduce the Keychain hop it replaced', () => {
    const { spawn, captured } = fakeSpawn();
    // The variable geniro used to mint from the Keychain. Nothing sources it
    // now, so setting it must have no effect on the child.
    process.env.GENIRO_CURSOR_API_KEY = 'ck-from-geniro';
    delete process.env.CURSOR_API_KEY;
    new CursorAcpAdapter({ spawn }).start(BASE, () => {});
    expect(captured.env?.CURSOR_API_KEY).toBeUndefined();
    expect(captured.env?.GENIRO_CURSOR_API_KEY).toBeUndefined();
  });

  it("re-injects the USER's own inherited key for its own child", () => {
    // `buildChildEnv` strips CURSOR_API_KEY from every child so it can never
    // reach the claude agent; this override is what keeps env-var auth working
    // for the one child entitled to it. Delete the override and this fails.
    const { spawn, captured } = fakeSpawn();
    process.env.CURSOR_API_KEY = 'ck-user-own';
    new CursorAcpAdapter({ spawn }).start(BASE, () => {});
    expect(captured.env?.CURSOR_API_KEY).toBe('ck-user-own');
  });

  it('lets a per-call env override win over the inherited key', () => {
    const { spawn, captured } = fakeSpawn();
    process.env.CURSOR_API_KEY = 'ck-user-own';
    new CursorAcpAdapter({ spawn }).start(
      { ...BASE, env: { CURSOR_API_KEY: 'ck-explicit' } },
      () => {},
    );
    expect(captured.env?.CURSOR_API_KEY).toBe('ck-explicit');
  });

  it('offers sign-in on the failure a signed-out turn actually produces', () => {
    // OBSERVED 2026-08-12 on 2026.08.04-aaa8809 with the account logged out:
    // session/new answers -32000 'Authentication required', which the ACP
    // driver renders as `acp session failed: <message>`. Empty the adapter's
    // expiredMarkers and this returns null — no Sign-in control on the row.
    const adapter = new CursorAcpAdapter({ spawn: fakeSpawn().spawn });
    expect(
      adapter.errorRecovery('acp session failed: Authentication required'),
    ).toBe('cli-login');
    expect(adapter.errorRecovery('acp prompt failed: rate limited')).toBeNull();
  });

  it('does not offer sign-in for someone else’s "Authentication required"', () => {
    // The marker is matched against the WHOLE failure message, and a non-zero
    // exit carries the child's stderr tail — where `cursor-agent acp`'s own MCP
    // health-checks log. An HTTP server answering 401 must not send the user to
    // re-authenticate an account that was never the problem, which is why the
    // marker is anchored to the driver's own rendering. Widen it back to the
    // bare phrase and this fails.
    const adapter = new CursorAcpAdapter({ spawn: fakeSpawn().spawn });
    expect(
      adapter.errorRecovery(
        'cursor-agent exited with code 1: mcp server foo: Authentication required',
      ),
    ).toBeNull();
  });

  it('refuses a config directory without claiming geniro injects the account', () => {
    // The old reason said cursor "takes its account from the API key geniro
    // injects". That injection is gone, so the sentence would have been a
    // falsehood shown to the user. The verdict stands on the re-probed reason.
    const reason = new CursorAcpAdapter({
      spawn: fakeSpawn().spawn,
    }).getConfig().configDir.unavailableReason;
    expect(reason).not.toBeNull();
    expect(reason).not.toContain('geniro injects');
    expect(reason).toContain('outside');
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
      // The chunk streams as an ephemeral delta; the durable row arrives once,
      // when the block closes at the end of the turn.
      { type: 'text_delta', text: 'done' },
      { type: 'text', text: 'done' },
      {
        type: 'turn_complete',
        usage: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          thinkingTokens: null,
          contextTokens: null,
          contextWindowTokens: null,
          contextModel: null,
          costUsd: null,
          durationMs: null,
          apiMs: null,
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
      // ACP carries no system-prompt field, so the host preamble rides the
      // prompt text itself — ahead of the user's message, on every turn.
      prompt: [{ type: 'text', text: `${GENIRO_UI_PREAMBLE}\n\nship it` }],
    });
  });
});

/**
 * A child whose `kill` actually ends it. The reported-commands probe cancels
 * its own turn the moment the report lands, so without this the turn never
 * settles and the probe waits out its deadline.
 */
class KillableAcpChild extends FakeChild {
  override kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    super.kill(signal);
    // A real child's `close` lands after the signal, never within it.
    setTimeout(() => this.emit('close', null, signal), 0);
    return true;
  }
}

describe('CursorAcpAdapter self-reported commands', () => {
  /**
   * The probe settings the adapter ACTUALLY SHIPS, read off its config rather
   * than off a literal next door: config is what `listReportedCommands` reads,
   * so a value that stopped being wired into it fails here instead of passing
   * against a name nothing uses.
   */
  function shippedProbe(): NonNullable<AdapterConfig['reportedCommands']> {
    const probe = new CursorAcpAdapter().getConfig().reportedCommands;
    if (!probe) {
      throw new Error(
        'cursor-agent must ship a reportedCommands probe — without it a folder ' +
          'no turn has run in lists nothing the CLI reports about itself',
      );
    }
    return probe;
  }

  it('asks the CLI what it offers, off the handshake and before any prompt', async () => {
    // The defect this closes, measured 2026-08-19 on 2026.08.11-e8db854: the
    // adapter declared `reportedCommands: null` and deferred to the mid-turn
    // harvest, which only exists once a turn has run in that folder — so a
    // fresh chat listed the disk scan alone. The CLI offered 27 commands and
    // the composer showed 21.
    shippedProbe();
    const child = new KillableAcpChild(4242);
    const { spawn } = fakeSpawn(child);
    const reported = new CursorAcpAdapter({
      spawn,
      probeRootDir: mkdtempSync(join(tmpdir(), 'cursor-probe-root-')),
    }).listReportedCommands();

    handshake(child);
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'review-agent', description: 'Read-only defect review' },
          { name: 'worktree', description: null },
        ],
      }),
    );

    await expect(reported).resolves.toEqual([
      { name: 'review-agent', description: 'Read-only defect review' },
      { name: 'worktree', description: null },
    ]);
    // Resolved without the turn ever ending: no `stopReason` reply was emitted,
    // so this cannot have waited the turn out. The report rides the handshake
    // rather than the answer, and the turn is cancelled the moment it lands.
    expect(
      framesOn(child).some((frame) => frame.method === 'session/prompt'),
    ).toBe(true);
    expect(child.kills).toBeGreaterThan(0);
  });

  it('keeps every name the CLI reports — this one has no internals to strip', async () => {
    // claude reports `__remote-workflow`-style internals and declares a prefix
    // for them. Across both readings of cursor-agent (27 entries in a git repo,
    // 22 in an empty directory) every entry was user-invokable, so the null is
    // a measurement and this is what fails if a filter is added on a hunch.
    expect(shippedProbe().internalPrefix).toBeNull();

    const child = new KillableAcpChild(4243);
    const { spawn } = fakeSpawn(child);
    const reported = new CursorAcpAdapter({
      spawn,
      probeRootDir: mkdtempSync(join(tmpdir(), 'cursor-probe-root-')),
    }).listReportedCommands();

    handshake(child);
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: '_internal-looking', description: null },
          { name: 'share', description: null },
        ],
      }),
    );

    await expect(reported).resolves.toEqual([
      { name: '_internal-looking', description: null },
      { name: 'share', description: null },
    ]);
  });
});

describe('CursorAcpAdapter serves one turn per process', () => {
  it('refuses a second turn even when the caller asks for a run-scoped session', () => {
    // The observable is that the caller's `runScoped` opt-in does not make the
    // session reusable — so the registry respawns, as it does today, instead of
    // holding a process that would answer the next prompt with the previous
    // turn's context.
    //
    // This is forward regression coverage, not a pin on the `canHostSession`
    // override: the base already answers false, so the override is a
    // readability choice (declaring the fact where a reader of this adapter
    // will look for it) and deleting it changes nothing observable here.
    const { spawn } = fakeSpawn();
    const session = new CursorAcpAdapter({ spawn }).startSession(BASE, {
      runScoped: true,
    });

    expect(session.startTurn(BASE, () => {})).not.toBeNull();
    expect(session.idle).toBe(false);
    expect(session.startTurn(BASE, () => {})).toBeNull();
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
    // The node role still leads the user's message; the host preamble sits
    // ahead of both, per composeTurnInstructions' general → specific order.
    expect(prompt.prompt[0]?.text).toBe(
      `${GENIRO_UI_PREAMBLE}\n\nYou are a reviewer.\n\nship it`,
    );
  });

  it('carries the user’s custom instructions into the prompt text', () => {
    // The sibling of the claude argv case. ACP has no system-prompt field at
    // all, so the SAME composed block reaches this CLI as leading prompt text
    // — one seam, both transports, which is what stops the two drifting into
    // separate delivery rules.
    const { spawn, child } = fakeSpawn();
    new CursorAcpAdapter({ spawn }).start(
      { ...BASE, customInstructions: 'Always answer in British English.' },
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
    expect(prompt.prompt[0]?.text).toBe(
      `${GENIRO_UI_PREAMBLE}\n\nAlways answer in British English.\n\nship it`,
    );
  });

  it('applies a requested model the agent offers, before prompting', () => {
    // The turn used to announce up front that the model had been dropped —
    // ACP does carry one (`session/set_model`, probe-verified on
    // 2026.08.04-aaa8809), so the frame is sent and no such notice fires.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    new CursorAcpAdapter({ spawn }).start(
      { ...BASE, model: 'claude-opus-5[thinking=true]' },
      (event) => events.push(event),
    );
    child.stdout.emitData(
      `${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({
        id: 2,
        result: {
          sessionId: 's',
          models: {
            currentModelId: 'composer-2.5',
            availableModels: [{ modelId: 'claude-opus-5', name: 'Opus 5' }],
          },
        },
      })}\n`,
    );

    const methods = framesOn(child).map((frame) => frame.method);
    expect(
      framesOn(child).find((frame) => frame.method === 'session/set_model')
        ?.params,
    ).toEqual({ sessionId: 's', modelId: 'claude-opus-5' });
    // Order is the whole mechanism: the frames share one ordered stream, so a
    // set_model AFTER the prompt would apply to the next turn, not this one.
    expect(methods.indexOf('session/set_model')).toBeLessThan(
      methods.indexOf('session/prompt'),
    );
    expect(events.filter((event) => event.type === 'notice')).toEqual([]);
  });

  it('splits a LEGACY bracketed id and applies the model before its parameters', () => {
    // Every cursor chat created before the parameterized handshake stored the
    // composed form, and that form is `-32602 Invalid params` in the mode a turn
    // now speaks. Splitting it is what keeps those chats running on exactly the
    // settings they were made with. ORDER is load-bearing and not cosmetic: a
    // parameter's existence depends on the current model, so `effort` before
    // `model` is "Unknown model config option".
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    new CursorAcpAdapter({ spawn }).start(
      {
        ...BASE,
        model:
          'claude-opus-5[thinking=true,context=300k,effort=high,fast=false]',
        // The turn's OWN effort, which must WIN over the one baked into the id
        // months ago — otherwise the new picker could never change anything on
        // an existing chat.
        effort: 'xhigh',
      },
      (event) => events.push(event),
    );
    child.stdout.emitData(
      `${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({
        id: 2,
        result: {
          sessionId: 's',
          // The parameterized shape: a model config option carrying BARE names.
          configOptions: [
            {
              id: 'model',
              category: 'model',
              currentValue: 'auto-smart',
              options: [{ value: 'claude-opus-5' }, { value: 'auto-smart' }],
            },
          ],
        },
      })}\n`,
    );

    const settings = framesOn(child)
      .filter((frame) => frame.method === 'session/set_config_option')
      .map((frame) => frame.params as { configId: string; value: string })
      .map((params) => [params.configId, params.value]);
    expect(settings).toEqual([
      ['model', 'claude-opus-5'],
      ['thinking', 'true'],
      ['context', '300k'],
      ['fast', 'false'],
      // Last, and `xhigh` rather than the id's `high`.
      ['effort', 'xhigh'],
    ]);
    const methods = framesOn(child).map((frame) => frame.method);
    expect(methods.lastIndexOf('session/set_config_option')).toBeLessThan(
      methods.indexOf('session/prompt'),
    );
    expect(events.filter((event) => event.type === 'notice')).toEqual([]);
  });

  it('sets the effort even when the run keeps the agent’s own model', () => {
    // The ordinary case for a chat left on "default model": there is no model to
    // apply, and the effort must still go out. An early return on "no model"
    // makes the picker inert for exactly those runs.
    const { spawn, child } = fakeSpawn();
    new CursorAcpAdapter({ spawn }).start({ ...BASE, effort: 'max' }, () => {});
    child.stdout.emitData(
      `${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({ id: 2, result: { sessionId: 's' } })}\n`,
    );

    expect(
      framesOn(child)
        .filter((frame) => frame.method === 'session/set_config_option')
        .map((frame) => (frame.params as { configId: string }).configId),
    ).toEqual(['effort']);
  });

  it('points the child at its OWN config dir, never the user’s ~/.cursor', () => {
    // THE leak fix. Applying a model or an effort over ACP persists into the
    // config directory — measured: one `set_config_option` changed `model`,
    // `selectedModel` and `modelSelectionHistory` in the real
    // `~/.cursor/cli-config.json`. So a chat's model choice used to change what
    // the user's own `cursor-agent` opens with. Drop this and it does again.
    const { spawn, captured } = fakeSpawn();
    const profileDir = mkdtempSync(join(tmpdir(), 'cursor-profiles-spec-'));
    dirs.push(profileDir);

    new CursorAcpAdapter({ spawn, profileDir }).start(BASE, () => {});

    const dir = captured.env?.CURSOR_CONFIG_DIR;
    expect(dir).toBeDefined();
    expect(dir!.startsWith(profileDir)).toBe(true);
    // And it is NOT the user's own, which is the whole point.
    expect(dir).not.toContain('/.cursor');
  });

  it('opens the turn’s profile ON the run’s own model', () => {
    // What makes every later check possible: a `session/new` reply describes
    // the CURRENT model, so a session opened on the user's default says nothing
    // about the model this turn will run on — its effort vocabulary included.
    // Seeded, the first reply describes the right model, and the model frame is
    // not needed at all.
    const { spawn, captured } = fakeSpawn();
    const profileDir = mkdtempSync(join(tmpdir(), 'cursor-profiles-spec-'));
    dirs.push(profileDir);

    new CursorAcpAdapter({ spawn, profileDir }).start(
      { ...BASE, model: 'grok-4.6' },
      () => {},
    );

    const config = JSON.parse(
      readFileSync(
        join(captured.env!.CURSOR_CONFIG_DIR!, 'cli-config.json'),
        'utf8',
      ),
    ) as { model?: { modelId?: string } };
    expect(config.model?.modelId).toBe('grok-4.6');
  });

  it('seeds the BARE name out of a legacy composed id', () => {
    // Existing chats store `claude-opus-5[thinking=true,…]`, and
    // `cli-config.json` names a model rather than a variant — writing the
    // bracketed form is a name the CLI does not know, which falls back to
    // `auto-smart` and describes the wrong model's options.
    const { spawn, captured } = fakeSpawn();
    const profileDir = mkdtempSync(join(tmpdir(), 'cursor-profiles-spec-'));
    dirs.push(profileDir);

    new CursorAcpAdapter({ spawn, profileDir }).start(
      { ...BASE, model: 'claude-opus-5[thinking=true,effort=high]' },
      () => {},
    );

    const config = JSON.parse(
      readFileSync(
        join(captured.env!.CURSOR_CONFIG_DIR!, 'cli-config.json'),
        'utf8',
      ),
    ) as { model?: { modelId?: string } };
    expect(config.model?.modelId).toBe('claude-opus-5');
  });

  it('links that config dir’s conversation store at one the turn cannot delete', () => {
    // The other half of the leak fix, and the half that was missing: the CLI
    // keeps each ACP conversation at `<configDir>/acp-sessions/<id>/`, so the
    // throwaway directory took the thread with it and a cursor chat's SECOND
    // message died at `session/load` ("Session … not found"). Drop the store and
    // the leak test above still passes while every chat becomes single-turn.
    const { spawn, captured } = fakeSpawn();
    const profileDir = mkdtempSync(join(tmpdir(), 'cursor-profiles-spec-'));
    const storeParent = mkdtempSync(join(tmpdir(), 'cursor-store-spec-'));
    const sessionStoreDir = join(storeParent, 'cursor-sessions');
    dirs.push(profileDir, storeParent);

    new CursorAcpAdapter({ spawn, profileDir, sessionStoreDir }).start(
      BASE,
      () => {},
    );

    const dir = captured.env?.CURSOR_CONFIG_DIR;
    const link = join(dir!, 'acp-sessions');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(sessionStoreDir));
    // OUTSIDE the profile base, which the boot sweep removes wholesale.
    expect(realpathSync(sessionStoreDir).startsWith(profileDir)).toBe(false);
  });

  it('lets a caller’s explicit config dir win over the throwaway one', () => {
    // A node pointed at a profile must not be silently overridden by the
    // per-turn directory — that would disable the feature from underneath it.
    const { spawn, captured } = fakeSpawn();
    const profileDir = mkdtempSync(join(tmpdir(), 'cursor-profiles-spec-'));
    dirs.push(profileDir);

    new CursorAcpAdapter({ spawn, profileDir }).start(
      { ...BASE, env: { CURSOR_CONFIG_DIR: '/explicit/profile' } },
      () => {},
    );

    expect(captured.env?.CURSOR_CONFIG_DIR).toBe('/explicit/profile');
  });

  it('declares the client flag that makes a separate effort exist at all', () => {
    // Without `_meta.parameterizedModelPicker` the agent composes one opaque id
    // per model family and rejects every recomposed effort — which is what made
    // "I cannot change the effort of a Cursor model" true. Drop this and the
    // effort picker silently stops working while every test above still passes,
    // because the frames would look identical.
    const { spawn, child } = fakeSpawn();
    new CursorAcpAdapter({ spawn }).start(BASE, () => {});

    const init = framesOn(child).find((frame) => frame.method === 'initialize')
      ?.params as { clientCapabilities?: { _meta?: unknown } } | undefined;
    expect(init?.clientCapabilities?._meta).toEqual({
      parameterizedModelPicker: true,
    });
  });

  it('says so when the agent does not offer the requested model', () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    new CursorAcpAdapter({ spawn }).start(
      { ...BASE, model: 'gpt-5' },
      (event) => events.push(event),
    );
    child.stdout.emitData(
      `${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`,
    );
    child.stdout.emitData(
      `${JSON.stringify({
        id: 2,
        result: {
          sessionId: 's',
          models: {
            currentModelId: 'composer-2.5[fast=true]',
            availableModels: [{ modelId: 'composer-2.5[fast=true]' }],
          },
        },
      })}\n`,
    );

    expect(events).toContainEqual({
      type: 'notice',
      message:
        "agent does not offer the model 'gpt-5' — this turn runs on the agent's current model instead",
    });
    // Not merely announced — the frame must not go out either, or the agent
    // answers with an error the turn would then have to explain twice.
    expect(framesOn(child).map((frame) => frame.method)).not.toContain(
      'session/set_model',
    );
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

describe('CursorAcpAdapter — no mid-turn user message', () => {
  it('refuses one rather than writing a frame the protocol has no place for', () => {
    // ACP's `session/prompt` is ONE request per turn, and the protocol gives a
    // client no way to add to a prompt already accepted. Reporting false is
    // what keeps the caller's queue correct: the message waits for the next
    // turn instead of being dropped as delivered. Claude's stdin answers true
    // here, and the two must stay tellable apart by the ANSWER, not by the
    // caller checking which CLI it is talking to.
    const child = new FakeChild();
    const spawn: SpawnFn = () => child as unknown as SpawnedProcess;
    const handle = new CursorAcpAdapter({ spawn }).start(
      { ...BASE, prompt: 'go' },
      () => {},
    );

    expect(handle.sendUserMessage({ text: 'and also this' })).toBe(false);
  });
});

describe('CursorAcpAdapter — cannot reopen a conversation', () => {
  it('refuses, and NAMES THE MECHANISM rather than merely declining', () => {
    // Re-verified 2026-08-12 against 2026.08.11-e8db854 + Cursor 3.15.6: the
    // ACP store (`~/.cursor/acp-sessions/<uuid>/`) and the store `--resume`
    // reads (`~/.cursor/chats/<md5(cwd)>/`) are two hardcoded paths in the
    // shipped bundle with nothing joining them, and the only `cursor://` route
    // in the whole binary targets no thread.
    //
    // The sentence is what the panel renders on the inert control, so it has to
    // say something the user can act on — this asserts the mechanism is in it,
    // not just that some string exists. A generic "no interactive terminal
    // session" (which the capability route used to compose) would pass a
    // non-empty check and fail this one.
    const reason = new CursorAcpAdapter().handoffUnavailableReason();

    expect(reason).toEqual(expect.any(String));
    expect(reason).toContain('chat store');
    // And the refusal itself still holds for a real-looking session id — the
    // danger being that `--resume` ACCEPTS an unknown one and silently opens an
    // EMPTY chat, so a wired button would look like it worked.
    expect(
      new CursorAcpAdapter().handoffTarget({
        sessionId: 'fa6e9302-6ae4-4ea7-ba35-536fc8cc1e29',
        model: null,
      }),
    ).toEqual({ ok: false, reason: 'unsupported' });
  });
});

describe('CursorAcpAdapter — background sub-agents', () => {
  /**
   * Every frame below is transcribed from the wire, cursor-agent
   * 2026.08.11-e8db854, 2026-08-13 — see the `Background sub-agents` block in
   * `cursor-acp.const.ts`. That matters here more than usual: the declaration
   * this replaces said cursor reports no delegates, and it was written from
   * geniro's own types rather than from frames like these.
   */
  const LAUNCH = sessionUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_018bc',
    title: 'Task: Subagent task',
    kind: 'other',
    status: 'pending',
    rawInput: { _toolName: 'task' },
  });

  function taskAnnouncement(params: Record<string, unknown>, id = 7): string {
    return stdoutLine({ jsonrpc: '2.0', id, method: 'cursor/task', params });
  }

  function driveTurn(): { child: FakeChild; events: AgentEvent[] } {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    new CursorAcpAdapter({ spawn }).start({ ...BASE }, (event) =>
      events.push(event),
    );
    handshake(child);
    return { child, events };
  }

  it('declares that it reports delegates, but not the work inside them', () => {
    const config = new CursorAcpAdapter().getConfig();
    expect(config.subagents.reports).toBe(true);
    expect(config.subagents.unavailableReason).toBeNull();
    // The one asymmetry with claude, and the reason a second field exists: the
    // delegation is announced, its steps never are. A null here would promise a
    // conversation the card can never fill.
    expect(config.subagents.stepsUnavailableReason).toContain(
      'not the work inside it',
    );
  });

  it('announces a delegate as soon as the launch frame arrives, before its brief', () => {
    // What makes the block open — and the run read as busy — while the delegate
    // is still working. The launch frame names no description at all (its title
    // is the CLI's placeholder), so the anchor is all this row can carry.
    const { child, events } = driveTurn();
    child.stdout.emitData(LAUNCH);

    const info = events.filter((event) => event.type === 'subagent_info');
    expect(info).toEqual([
      {
        type: 'subagent_info',
        id: 'toolu_018bc',
        label: null,
        kind: null,
        prompt: null,
        model: null,
        durationMs: null,
        stepsUnavailableReason: expect.stringContaining(
          'not the work inside it',
        ),
        backgroundOpen: null,
      },
    ]);
    // AFTER the tool call it anchors to, so a consumer replaying in seq order
    // has the row before anything references it.
    const kinds = events.map((event) => event.type);
    expect(kinds.indexOf('tool_call')).toBeLessThan(
      kinds.indexOf('subagent_info'),
    );
  });

  it('leaves an ordinary tool call alone — the marker is what makes it a delegation', () => {
    const { child, events } = driveTurn();
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 't-1',
        title: 'Read a file',
        rawInput: { _toolName: 'read', path: '/repo/a.ts' },
      }),
    );
    // And one that disclosed no arguments at all, which is routine on this
    // transport (`rawInput: {}` normalizes to null) — reading the marker off it
    // must not throw or invent a delegate.
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 't-2',
        title: 'Search',
        rawInput: {},
      }),
    );

    expect(events.some((event) => event.type === 'subagent_info')).toBe(false);
  });

  it('ANSWERS the announcement and records the delegate it describes', () => {
    const { child, events } = driveTurn();
    child.stdout.emitData(LAUNCH);
    child.stdout.emitData(
      taskAnnouncement({
        toolCallId: 'toolu_018bc',
        description: 'List files in directory',
        prompt: 'Your task is simple and self-contained: …',
        subagentType: { custom: { unspecified: {} } },
        model: 'claude-opus-5-thinking-high',
        agentId: 'bce43ebb-cf88-4adf-bb10-33f0b5458f45',
        durationMs: 13075,
      }),
    );

    expect(
      events.filter((event) => event.type === 'subagent_info').at(-1),
    ).toEqual({
      type: 'subagent_info',
      id: 'toolu_018bc',
      label: 'List files in directory',
      // `{custom:{unspecified:{}}}` names no type — the row says nothing rather
      // than labelling the delegate `unspecified`.
      kind: null,
      prompt: 'Your task is simple and self-contained: …',
      model: 'claude-opus-5-thinking-high',
      durationMs: 13075,
      stepsUnavailableReason: expect.stringContaining('not the work inside it'),
      backgroundOpen: null,
    });
    // Answered, not declined. The refusal is what this whole feature was lost
    // behind: the agent discards the outcome either way, so a `-32601` cost the
    // turn nothing and silently threw the brief away.
    const reply = framesOn(child).find((frame) => frame.id === 7);
    expect(reply).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
    // …and it does NOT burn the turn's one "declined" notice, which is what
    // being on the silent list used to buy.
    expect(events.some((event) => event.type === 'notice')).toBe(false);
  });

  it('declines an announcement it cannot read, rather than writing a blank delegate', () => {
    const { child, events } = driveTurn();
    // No `toolCallId`: nothing to anchor a block to, so there is no row worth
    // writing and the request falls through to the ordinary decline.
    child.stdout.emitData(taskAnnouncement({ description: 'orphan' }, 9));

    expect(events.some((event) => event.type === 'subagent_info')).toBe(false);
    const reply = framesOn(child).find((frame) => frame.id === 9);
    expect(reply?.error).toMatchObject({ code: -32601 });
  });

  it('drops the launching tool’s accounting instead of framing it as the delegate’s answer', () => {
    // Measured: the `task` call completes with `{durationMs, isBackground}` and
    // the findings appear only in the main agent's next message. Rendered as
    // `Result from <delegate>`, that object printed where the reader looks for
    // what the delegate found.
    const { child, events } = driveTurn();
    child.stdout.emitData(LAUNCH);
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'toolu_018bc',
        status: 'completed',
        rawOutput: { durationMs: 15430, isBackground: false },
      }),
    );

    const result = events.find((event) => event.type === 'tool_result');
    // The pair still CLOSES — the block reads `completed` off the result's
    // existence, so suppressing the row itself would leave a finished delegate
    // spinning forever.
    expect(result).toMatchObject({ id: 'toolu_018bc', result: null });
  });

  it('keeps an ordinary tool call’s output, which IS its answer', () => {
    // The other half of the rule: only a recognised delegation's result is
    // accounting. A blanket drop would empty every shell and search row.
    const { child, events } = driveTurn();
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 't-1',
        title: 'Shell',
        rawInput: { _toolName: 'shell', command: 'ls' },
      }),
    );
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't-1',
        status: 'completed',
        rawOutput: { stdout: 'alpha.txt\n' },
      }),
    );

    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      result: { stdout: 'alpha.txt\n' },
    });
  });

  it('keeps `cursor/task` OFF the silently-declined list, so a refusal cannot go unnoticed', () => {
    // The list is what hid this for two milestones. A future entry for it would
    // restore exactly that: declined in protocol, no notice, no row.
    expect(CURSOR_SILENTLY_DECLINED_METHODS).not.toContain('cursor/task');
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
      prompt: [{ type: 'text', text: `${GENIRO_UI_PREAMBLE}\n\nturn A` }],
    });
    expect(
      framesOn(childB).find((frame) => frame.method === 'session/prompt')
        ?.params,
    ).toEqual({
      sessionId: 'sess-b',
      prompt: [{ type: 'text', text: `${GENIRO_UI_PREAMBLE}\n\nturn B` }],
    });
  });
  describe('listModels', () => {
    /**
     * A double for the model handshake. Deliberately NEVER closes: probed on
     * cursor-agent 2026.08.04-aaa8809, `cursor-agent acp` does not exit when
     * its stdin closes, so a double that exits would settle the read through
     * the `close` path and never exercise the early settle the real CLI needs.
     */
    function fakeAcpProbe(stdout: string): {
      groupSpawnFn: typeof spawn;
      captured: { args?: readonly string[]; stdin: () => string[] };
    } {
      let child = fakeGroupChild(4242);
      const captured = {
        args: undefined as readonly string[] | undefined,
        stdin: () => child.stdinChunks,
      };
      const groupSpawnFn = ((_command: string, args: readonly string[]) => {
        captured.args = args;
        child = fakeGroupChild(4242);
        queueMicrotask(() => child.writeStdout(stdout));
        return child.child;
      }) as unknown as typeof spawn;
      return { groupSpawnFn, captured };
    }

    const SESSION_REPLY = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: {
        sessionId: 's1',
        models: {
          currentModelId: 'composer-2.5[fast=true]',
          // BARE ids, verbatim from a 2026.08.11-e8db854 `session/new` reply
          // under the PARAMETERIZED handshake — the one the probe now sends, so
          // this is the shape it really reads. Under the old handshake the same
          // models come back as composed ids (`claude-opus-5[thinking=true,…]`),
          // and a picker built from those has every choice refused.
          availableModels: [
            { modelId: 'composer-2.5', name: 'Composer 2.5' },
            { modelId: 'claude-opus-5', name: 'Opus 5' },
            { modelId: 'gpt-5.5', name: 'GPT-5.5' },
          ],
        },
      },
    })}\n`;

    it('asks the ACP server, not the `models` subcommand', async () => {
      // Load-bearing, not stylistic: the subcommand prints a DIFFERENT id
      // namespace (`claude-opus-5-thinking-high`) and `session/set_model`
      // answers those with `-32602 Invalid model value`, so a picker built
      // from it would refuse every choice the user made.
      const { groupSpawnFn, captured } = fakeAcpProbe(SESSION_REPLY);

      await new CursorAcpAdapter({ groupSpawnFn }).listModels();

      expect(captured.args).toEqual(['acp']);
    });

    it('writes the handshake frames the answer depends on', async () => {
      const { groupSpawnFn, captured } = fakeAcpProbe(SESSION_REPLY);

      await new CursorAcpAdapter({ groupSpawnFn }).listModels();

      const methods = captured
        .stdin()
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => (JSON.parse(line) as { method: string }).method);
      expect(methods).toEqual(['initialize', 'session/new']);
    });

    it('reports the models the handshake offered, marked as live', async () => {
      const { groupSpawnFn } = fakeAcpProbe(SESSION_REPLY);

      await expect(
        new CursorAcpAdapter({ groupSpawnFn }).listModels(),
      ).resolves.toEqual([
        { id: 'composer-2.5', label: 'Composer 2.5', source: 'cli' },
        { id: 'claude-opus-5', label: 'Opus 5', source: 'cli' },
        { id: 'gpt-5.5', label: 'GPT-5.5', source: 'cli' },
      ]);
    });

    it('reports nothing when the CLI could not be run at all', async () => {
      const groupSpawnFn = ((_command: string, _args: readonly string[]) => {
        const child = fakeGroupChild(4242);
        queueMicrotask(() => child.close(1));
        return child.child;
      }) as unknown as typeof spawn;

      await expect(
        new CursorAcpAdapter({ groupSpawnFn }).listModels(),
      ).resolves.toEqual([]);
    });
  });

  describe('listModelEfforts + listModelContextWindows share one handshake', () => {
    /**
     * A `session/new` reply carrying BOTH an `effort` and a `context` config
     * option, so a listing that reads a NON-fallback answer for its own axis
     * from the SAME stdout is evidence the raw reply was actually shared —
     * not merely that two independent probes happened to agree.
     */
    const CONFIG_REPLY = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: {
        sessionId: 's1',
        configOptions: [
          {
            id: 'effort',
            category: 'model_config',
            currentValue: 'medium',
            options: [
              { value: 'low', name: 'low' },
              { value: 'medium', name: 'medium' },
            ],
          },
          {
            id: 'context',
            category: 'model_config',
            currentValue: '300k',
            options: [
              { value: '300k', name: '300k' },
              { value: '1m', name: '1m' },
            ],
          },
        ],
      },
    })}\n`;

    /**
     * A double for the `session/new` handshake, counted through
     * `groupSpawnFn` itself — the seam `probeModelConfigOptions` actually
     * spawns through, so the count below is of REAL process-group spawns
     * rather than a proxy this spec invented. Deliberately NEVER closes, like
     * `fakeAcpProbe` above: `cursor-agent acp` does not exit on its own, so
     * `settleWhen` (not `close`) is what ends a real read.
     *
     * Each successive spawn gets the next `reply`, sticking on the last one —
     * a single-reply call therefore answers every spawn with that one reply.
     */
    function fakeAcpConfigProbe(
      firstReply: string,
      ...laterReplies: string[]
    ): {
      groupSpawnFn: typeof spawn;
      calls: () => number;
    } {
      const replies = [firstReply, ...laterReplies];
      let calls = 0;
      const groupSpawnFn = ((_command: string, _args: readonly string[]) => {
        const reply =
          replies[Math.min(calls, replies.length - 1)] ?? firstReply;
        calls += 1;
        const fake = fakeGroupChild(4242 + calls);
        queueMicrotask(() => fake.writeStdout(reply));
        return fake.child;
      }) as unknown as typeof spawn;
      return { groupSpawnFn, calls: () => calls };
    }

    /** Answers `<binary> --version` with a fixed line, through the seam `resolveBinaryVersion` reads. */
    function fakeVersion(version: () => string): typeof execFile {
      return ((
        _command: string,
        _args: readonly string[] | undefined,
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, `${version()}\n`, '');
        return {} as ChildProcess;
      }) as unknown as typeof execFile;
    }

    it('performs exactly ONE handshake probe for a cold model asked both ways', async () => {
      const { groupSpawnFn, calls } = fakeAcpConfigProbe(CONFIG_REPLY);
      const adapter = new CursorAcpAdapter({
        groupSpawnFn,
        execFileFn: fakeVersion(() => '2026.08.11-e8db854'),
      });

      const efforts = await adapter.listModelEfforts('claude-opus-5');
      const windows = await adapter.listModelContextWindows('claude-opus-5');

      // Each listing reads its OWN axis out of the one reply above — proof
      // the second call answered from the cache rather than from a fallback
      // that would also look plausible on its own.
      expect(efforts).toEqual({
        efforts: [
          { id: 'low', label: 'low' },
          { id: 'medium', label: 'medium' },
        ],
        unavailableReason: null,
        exact: true,
      });
      expect(windows).toEqual({
        windows: [
          { id: '300k', label: '300k' },
          { id: '1m', label: '1m' },
        ],
        unavailableReason: null,
        unavailableKind: null,
        exact: true,
      });
      // The assertion that fails the moment the shared cache is reverted: two
      // listings for the same cold model used to spawn their own `cursor-agent
      // acp` process group each.
      expect(calls()).toBe(1);
    });

    it('re-probes once the CLI binary version changes under the cache', async () => {
      const secondReply = `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          sessionId: 's2',
          configOptions: [
            {
              id: 'effort',
              category: 'model_config',
              currentValue: 'high',
              options: [{ value: 'high', name: 'high' }],
            },
          ],
        },
      })}\n`;
      // The FIRST spawn gets the cold reply; every spawn after it (there
      // should be exactly one more) gets the post-upgrade reply.
      const { groupSpawnFn, calls } = fakeAcpConfigProbe(
        CONFIG_REPLY,
        secondReply,
      );
      let version = '2026.08.11-e8db854';
      const adapter = new CursorAcpAdapter({
        groupSpawnFn,
        execFileFn: fakeVersion(() => version),
      });

      const before = await adapter.listModelEfforts('claude-opus-5');
      expect(before.efforts.map((e) => e.id)).toEqual(['low', 'medium']);
      expect(calls()).toBe(1);

      // The CLI itself upgraded under the running daemon — the exact case the
      // version check exists for. Reusing the version-1 entry here is the
      // failure this pins: a chat left open across an upgrade would otherwise
      // go on being told the OLD binary's vocabulary for the rest of the
      // 10-minute TTL.
      version = '2026.08.19-ffaa123';
      const after = await adapter.listModelEfforts('claude-opus-5');

      expect(after.efforts.map((e) => e.id)).toEqual(['high']);
      expect(calls()).toBe(2);
    });
  });

  describe('setMcpServerEnabled', () => {
    /**
     * Answers the toggle subcommand, capturing its argv and cwd.
     *
     * `execFileFn`, not `groupSpawnFn`: neither `mcp enable` nor `mcp disable`
     * dials anything, so this one deliberately does NOT take the process-group
     * path the listing beside it needs.
     */
    function fakeToggle(ok: boolean): {
      execFileFn: typeof execFile;
      captured: { args?: readonly string[]; cwd?: string };
    } {
      const captured: { args?: readonly string[]; cwd?: string } = {};
      const execFileFn = ((
        _cmd: string,
        args: readonly string[],
        opts: { cwd?: string },
        cb: (err: Error | null, out: string) => void,
      ) => {
        captured.args = args;
        captured.cwd = opts.cwd;
        // A non-zero exit reaches `execFile` as an error argument, which
        // `runCommand` turns into the null stdout this adapter reads as refusal.
        cb(ok ? null : new Error('exit 1'), ok ? 'done\n' : '');
        return {} as ChildProcess;
      }) as unknown as typeof execFile;
      return { execFileFn, captured };
    }

    it('switches a server OFF in the folder it was given', async () => {
      // The cwd IS the scoping mechanism: the CLI resolves its own per-project
      // state from `process.cwd()` (git root, else the folder), so passing it is
      // the whole reason one folder's switch is not another's. Drop the cwd and
      // every toggle would land on whatever directory the daemon was started in.
      const { execFileFn, captured } = fakeToggle(true);

      await new CursorAcpAdapter({ execFileFn }).setMcpServerEnabled(
        '/proj',
        'figma',
        false,
      );

      expect(captured.args).toEqual(['mcp', 'disable', 'figma']);
      expect(captured.cwd).toBe('/proj');
    });

    it('switches a server ON through `mcp enable`, which also approves it', async () => {
      // Not merely un-disabling: the CLI's own toggle is `addApproval` then
      // `removeDisabledServer` (its TUI handler, `6260.index.js`), and a server
      // that is un-disabled but unapproved is still prompted for. `enable` is
      // what makes the switch mean the same thing here as in the user's Cursor.
      const { execFileFn, captured } = fakeToggle(true);

      await new CursorAcpAdapter({ execFileFn }).setMcpServerEnabled(
        '/proj',
        'figma',
        true,
      );

      expect(captured.args).toEqual(['mcp', 'enable', 'figma']);
    });

    it('REJECTS when the CLI refused, instead of reporting a switch that never moved', async () => {
      // `mcp enable` exits 1 for a server no config defines (measured). Resolving
      // there would move the switch in the panel over a CLI that changed nothing
      // — the silent no-op this whole feature is written to avoid.
      const { execFileFn } = fakeToggle(false);

      await expect(
        new CursorAcpAdapter({ execFileFn }).setMcpServerEnabled(
          '/proj',
          'nope',
          true,
        ),
      ).rejects.toThrow(/refused to switch/);
    });

    it('hands its child to onSpawn, so the daemon can reap it', async () => {
      // Every child the daemon starts must be registerable; this adapter's
      // toggle is the one that spawns a process where claude's edits a file.
      let handed = 0;
      const { execFileFn } = fakeToggle(true);

      await new CursorAcpAdapter({ execFileFn }).setMcpServerEnabled(
        '/proj',
        'figma',
        false,
        { onSpawn: () => (handed += 1) },
      );

      expect(handed).toBe(1);
    });
  });

  describe('listMcpServers', () => {
    it('asks the CLI in the folder it was given, in its own process group', async () => {
      const { groupSpawnFn, captured } = fakeListing('probe: ready\n');

      await new CursorAcpAdapter({ groupSpawnFn }).listMcpServers({
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

    it("carries the user's inherited key, so the listing is not signed out", async () => {
      // `buildEnv` is reached from start() alone, so utility reads used to run
      // unauthenticated while turns worked: an env-var-only account saw an empty
      // MCP panel, which reads as "this folder has no servers" rather than "we
      // could not ask". `utilityEnv` is what closes that. Delete the override
      // and this fails.
      process.env.CURSOR_API_KEY = 'ck-user-own';
      const { groupSpawnFn, captured } = fakeListing('probe: ready\n');

      await new CursorAcpAdapter({ groupSpawnFn }).listMcpServers({
        cwd: '/proj',
      });

      expect(captured.opts?.env?.CURSOR_API_KEY).toBe('ck-user-own');
    });

    it('reports the servers the CLI listed', async () => {
      const { groupSpawnFn } = fakeListing(
        'probe-good: ready\nprobe-broken: Error: Connection failed\n',
      );

      await expect(
        new CursorAcpAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/proj' }),
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
      const { groupSpawnFn } = fakeListing(
        'No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)\n',
      );

      await expect(
        new CursorAcpAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/proj' }),
      ).resolves.toEqual({ ok: true, servers: [] });
    });

    it('reports a command that could not be run as a FAILURE, never as empty', async () => {
      // null stdout is the missing binary / non-zero exit / deadline signal.
      // An `ok: true, servers: []` here would be cached and shown as "no
      // servers" — a lie about the user's configuration for as long as the
      // entry lives.
      //
      // `process.kill` is mocked because the error path reaps the group: with
      // the fake's invented pid 4242 this spec would otherwise SIGKILL
      // whatever process group owns that pid on the machine running it.
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((): true => true);
      try {
        const { groupSpawnFn } = fakeListing(null);

        await expect(
          new CursorAcpAdapter({ groupSpawnFn }).listMcpServers({
            cwd: '/proj',
          }),
        ).resolves.toEqual({
          ok: false,
          reason: expect.stringContaining('did not answer'),
        });
      } finally {
        killSpy.mockRestore();
      }
    });

    it('reports output with no rows in it at all as a FAILURE, not an empty folder', async () => {
      // Reached when NOTHING in the output is shaped like a row and the CLI
      // did not print its empty-folder sentence either. Without this branch
      // that is indistinguishable from an empty folder and the panel would
      // confidently say "No servers".
      const { groupSpawnFn } = fakeListing('something went sideways\n');

      await expect(
        new CursorAcpAdapter({ groupSpawnFn }).listMcpServers({ cwd: '/proj' }),
      ).resolves.toEqual({
        ok: false,
        reason: expect.stringContaining('format may have changed'),
      });
    });

    it('does not read the empty-folder sentence out of the MIDDLE of a row', async () => {
      // The sentence is ordinary English. Searched across the whole buffer, a
      // server whose status wording merely contains it would satisfy the empty
      // check — turning "we could not read this" into the one claim the output
      // does not support: that the folder has no servers.
      const { groupSpawnFn } = fakeListing(
        'weird-srv: No MCP servers configured are approved yet\n',
      );

      const result = await new CursorAcpAdapter({
        groupSpawnFn,
      }).listMcpServers({
        cwd: '/proj',
      });

      expect(result.ok && result.servers.map((s) => s.name)).toEqual([
        'weird-srv',
      ]);
    });

    it('asks for the process-group reap when the command answers', async () => {
      // The health check launches the user's own MCP servers as children; one
      // that ignores stdin EOF outlives the CLI, and once the CLI exits the
      // registry has dropped the only handle that could reach it.
      //
      // The reap now genuinely lands: the group path spawns `detached`, so
      // the negative pid names a group that exists. See the twin case in
      // `agent-adapter.spec.ts`, which pins the spawn options themselves.
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((): true => true);
      try {
        const { groupSpawnFn } = fakeListing('probe: ready\n');

        await new CursorAcpAdapter({ groupSpawnFn }).listMcpServers({
          cwd: '/proj',
        });

        expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
      } finally {
        killSpy.mockRestore();
      }
    });

    it('never answers with a confident listing that omits a row it could not read', async () => {
      // The unreadable answer above only fires when EVERY row drops, and a
      // PARTLY reworded listing is the likelier release: one server carries a
      // wording this vocabulary does not have while the rest still read. If
      // the unreadable row is dropped, the result is no longer empty, the
      // three-way split never reaches its third arm, and the listing goes out
      // as `ok: true` — so the panel states, as fact, that `linear` is the
      // only server in a folder that has two. `AgentMcpService` caches only
      // `ok` results, so that answer then stands for the whole TTL.
      const { groupSpawnFn } = fakeListing(
        'linear: ready\nsentry: awaiting-auth\n',
      );

      const result = await new CursorAcpAdapter({
        groupSpawnFn,
      }).listMcpServers({
        cwd: '/proj',
      });
      const answer = result.ok
        ? result.servers.map((server) => server.name)
        : result.reason;

      // Either honest answer passes: reporting the output as unreadable, or
      // keeping `sentry` with its health unstated the way the claude parser
      // does. Naming `linear` alone is the one answer that denies a server
      // the CLI printed.
      expect(answer).not.toEqual(['linear']);
    });
  });

  describe('bringing a conversation across into geniro’s own store', () => {
    /** A user profile holding one session dir, plus geniro's empty store. */
    function stores(): { home: string; store: string; source: string } {
      const home = mkdtempSync(join(tmpdir(), 'cursor-home-'));
      const store = mkdtempSync(join(tmpdir(), 'cursor-store-'));
      dirs.push(home, store);
      const source = join(
        home,
        CURSOR_HOME_DIR_NAME,
        CURSOR_ACP_SESSIONS_DIR_NAME,
        'sess-1',
      );
      mkdirSync(source, { recursive: true });
      return { home, store, source };
    }

    function importSession(home: string, store: string): Promise<void> {
      return new CursorAcpAdapter({
        homeDir: home,
        sessionStoreDir: store,
      }).prepareSessionImport({
        sessionId: 'sess-1',
        configDir: null,
        cwd: home,
      });
    }

    it('leaves NOTHING at the destination when the copy dies partway', async () => {
      // The defect this pins. The destination is guarded by an `existsSync`
      // early return, so a copy that failed halfway used to leave a populated
      // directory every LATER import short-circuits onto — `session/load` then
      // replays a truncated store and that conversation's history is gone for
      // good, with a notice as the only trace.
      const { home, store, source } = stores();
      writeFileSync(join(source, 'store.db'), 'the whole conversation');
      // A subdirectory the copy cannot read, so `cp` throws mid-walk. Which
      // entry it reaches first does not matter — either way the copy is
      // incomplete when it fails.
      const locked = join(source, 'blobs');
      mkdirSync(locked);
      writeFileSync(join(locked, 'blob-1'), 'x');
      chmodSync(locked, 0o000);

      try {
        await expect(importSession(home, store)).rejects.toThrow();

        expect(existsSync(join(store, 'sess-1'))).toBe(false);
        // And no staging litter either — a `.sess-1.<pid>.<n>.tmp` left behind
        // would accumulate one directory per failed import.
        expect(readdirSync(store)).toEqual([]);
      } finally {
        chmodSync(locked, 0o755);
      }

      // Now that the source can be read, the SAME id imports whole — which the
      // early return would have refused had the partial copy survived.
      await importSession(home, store);
      expect(readFileSync(join(store, 'sess-1', 'store.db'), 'utf8')).toBe(
        'the whole conversation',
      );
      expect(existsSync(join(store, 'sess-1', 'blobs', 'blob-1'))).toBe(true);
    });

    it('leaves a session already in the store alone', async () => {
      // The same id can be imported twice, and the second must not put a stale
      // copy over the turns this app has since added to it.
      const { home, store, source } = stores();
      writeFileSync(join(source, 'store.db'), 'as it was in the user profile');
      const destination = join(store, 'sess-1');
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, 'store.db'), 'with geniro’s turns in it');

      await importSession(home, store);

      expect(readFileSync(join(destination, 'store.db'), 'utf8')).toBe(
        'with geniro’s turns in it',
      );
    });

    it('refuses a session the user profile does not hold', async () => {
      const { home, store } = stores();
      rmSync(join(home, CURSOR_HOME_DIR_NAME, CURSOR_ACP_SESSIONS_DIR_NAME), {
        recursive: true,
        force: true,
      });

      await expect(importSession(home, store)).rejects.toThrow(
        CURSOR_SESSION_MISSING_MESSAGE,
      );
      expect(existsSync(join(store, 'sess-1'))).toBe(false);
    });

    it('keeps a session id carrying a separator inside the store it names', async () => {
      // The id is JOINED into two paths here, and it arrives over HTTP:
      // `POST /v1/chats` validates `resumeSessionId` as `z.string().min(1)`
      // and nothing else. The claude half of this same feature refuses a
      // separator outright — `findSessionFile` compares the assembled name
      // against its own `basename` — so an id that reaches a path is a case
      // this feature has already decided about once.
      //
      // A `..` walks BOTH ends of the copy out of the directories they name:
      // the source out of the CLI's `acp-sessions`, and the destination out of
      // geniro's session store, into whatever sits beside it.
      const home = mkdtempSync(join(tmpdir(), 'cursor-home-'));
      const beside = mkdtempSync(join(tmpdir(), 'cursor-beside-'));
      dirs.push(home, beside);
      const store = join(beside, 'cursor-sessions');
      // Something of the user's under `~/.cursor` that is NOT one of the CLI's
      // ACP conversations, and so is not this app's to move anywhere.
      const stray = join(home, CURSOR_HOME_DIR_NAME, 'not-a-session');
      mkdirSync(stray, { recursive: true });
      writeFileSync(join(stray, 'private'), 'never asked to be copied');

      await new CursorAcpAdapter({ homeDir: home, sessionStoreDir: store })
        .prepareSessionImport({
          sessionId: '../not-a-session',
          configDir: null,
          cwd: home,
        })
        // Refusing and doing nothing are both correct answers; landing the
        // copy outside the store is the one that is not.
        .catch(() => undefined);

      expect(existsSync(join(beside, 'not-a-session', 'private'))).toBe(false);
      expect(existsSync(join(beside, 'not-a-session'))).toBe(false);

      // And the ordinary id still imports, so the guard above is a guard and
      // not the method having stopped working.
      const source = join(
        home,
        CURSOR_HOME_DIR_NAME,
        CURSOR_ACP_SESSIONS_DIR_NAME,
        'sess-1',
      );
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, 'store.db'), 'the whole conversation');
      await importSession(home, store);
      expect(readFileSync(join(store, 'sess-1', 'store.db'), 'utf8')).toBe(
        'the whole conversation',
      );
    });
  });
});

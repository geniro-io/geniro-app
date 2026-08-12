import type { spawn } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeChild, fakeSpawn } from '../../__tests__/fake-child';
import type { SpawnedProcess, SpawnFn } from '../../utils/spawn-cli';
import { fakeGroupChild } from '../__tests__/fake-group-child';
import type { AcpToolCall } from '../acp/acp.types';
import type { AgentEvent, AgentTurnInput } from '../adapter.types';
import { CursorAcpAdapter, cursorAutoDecision } from './cursor-acp.adapter';

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
          contextTokens: null,
          contextWindowTokens: null,
          contextModel: null,
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
    expect(prompt.prompt[0]?.text).toBe('You are a reviewer.\n\nship it');
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
            currentModelId: 'composer-2.5[fast=true]',
            availableModels: [
              { modelId: 'claude-opus-5[thinking=true]', name: 'Opus 5' },
            ],
          },
        },
      })}\n`,
    );

    const methods = framesOn(child).map((frame) => frame.method);
    expect(
      framesOn(child).find((frame) => frame.method === 'session/set_model')
        ?.params,
    ).toEqual({ sessionId: 's', modelId: 'claude-opus-5[thinking=true]' });
    // Order is the whole mechanism: the frames share one ordered stream, so a
    // set_model AFTER the prompt would apply to the next turn, not this one.
    expect(methods.indexOf('session/set_model')).toBeLessThan(
      methods.indexOf('session/prompt'),
    );
    expect(events.filter((event) => event.type === 'notice')).toEqual([]);
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

describe('CursorAcpAdapter — no sub-agent signal', () => {
  it('declares that it reports none, with the reason beside it', () => {
    // A CLI with no answer declares that as a fact rather than leaving the
    // gap to be rediscovered (.claude/rules/agent-adapters.md). Claude
    // declares `reports: true`, so the two must stay tellable apart by the
    // DECLARATION rather than by a caller checking which CLI it is.
    const config = new CursorAcpAdapter().getConfig();
    expect(config.subagents.reports).toBe(false);
    expect(config.subagents.unavailableReason).toContain('no sub-agents');
  });

  it('never stamps a sub-agent origin on an event it emits', () => {
    // The observable half of the declaration above: nothing on this transport
    // sets `parentToolUseId`, so the renderer's enclosure has nothing to key
    // on and a cursor run honestly lists no delegates. If a future ACP variant
    // starts carrying one, this fails and the declaration gets revisited —
    // which is the point of pinning it against events rather than the string.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    new CursorAcpAdapter({ spawn }).start({ ...BASE }, (event) =>
      events.push(event),
    );
    handshake(child);
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'working' },
      }),
    );
    child.stdout.emitData(
      sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 't-1',
        title: 'Read a file',
        rawInput: { path: '/repo/a.ts' },
      }),
    );

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.parentToolUseId === undefined)).toBe(
      true,
    );
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
          availableModels: [
            { modelId: 'composer-2.5[fast=true]', name: 'Composer 2.5' },
            { modelId: 'claude-opus-5[thinking=true]', name: 'Opus 5' },
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
        {
          id: 'composer-2.5[fast=true]',
          label: 'Composer 2.5',
          source: 'cli',
        },
        { id: 'claude-opus-5[thinking=true]', label: 'Opus 5', source: 'cli' },
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
});

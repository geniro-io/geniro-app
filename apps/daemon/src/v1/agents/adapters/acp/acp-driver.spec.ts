import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { tempDir } from '../../__tests__/temp-dir';
import type { AgentEvent, AgentTurnInput } from '../adapter.types';
import type { AcpDriverOptions } from './acp-driver';
import { AcpTurnDriver, selectPermissionOption } from './acp-driver';

interface Harness {
  driver: AcpTurnDriver;
  /** Every frame the driver wrote to stdin, parsed. */
  sent: Record<string, unknown>[];
  /** Events the driver emitted through `io.emit` (the onStdinReady channel). */
  emitted: AgentEvent[];
  /** Feed one parsed stdout line; returns the events it produced. */
  feed: (message: unknown) => AgentEvent[];
  /** The frame for the Nth request the driver sent, by method name. */
  sentMethod: (method: string) => Record<string, unknown> | undefined;
}

const BASE_INPUT: AgentTurnInput = { prompt: 'do the thing', cwd: '/work' };

function harness(
  overrides: Partial<AcpDriverOptions> = {},
  writeResult = true,
): Harness {
  const sent: Record<string, unknown>[] = [];
  const emitted: AgentEvent[] = [];
  const input = overrides.input ?? BASE_INPUT;
  const driver = new AcpTurnDriver({
    input: BASE_INPUT,
    clientName: 'geniro',
    clientVersion: '1.2.3',
    autoDecide: () => null,
    // A STUB, not a mirror of AgentAdapter.composeSystemPrompt: these specs
    // pin what the DRIVER does with the callback's result — that it prepends
    // it, and that it passes the right `granted` — never how the text is
    // composed. The real join (host preamble, custom instructions, role, call
    // surface) is `composeTurnInstructions`, covered directly by
    // `utils/agent-instructions.spec.ts` and end-to-end through the real
    // adapter in `cursor-acp.adapter.spec.ts`.
    composeSystemPrompt: (granted) =>
      [input.systemPrompt, granted ? input.callSurfacePrompt : null]
        .filter((part): part is string => Boolean(part))
        .join('\n\n'),
    ...overrides,
  });
  driver.onStdinReady({
    write: (payload) => {
      if (!writeResult) {
        return false;
      }
      sent.push(JSON.parse(payload) as Record<string, unknown>);
      return true;
    },
    emit: (event) => emitted.push(event),
  });
  return {
    driver,
    sent,
    emitted,
    feed: (message) => driver.onMessage(message),
    sentMethod: (method) => sent.find((frame) => frame.method === method),
  };
}

/** The reply the agent sends to `initialize`, with the capabilities under test. */
function initializeReply(
  id: number,
  capabilities: { loadSession?: boolean; http?: boolean; image?: boolean } = {},
): unknown {
  return {
    id,
    result: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: capabilities.loadSession ?? false,
        mcpCapabilities: { http: capabilities.http ?? false },
        promptCapabilities: { image: capabilities.image ?? false },
      },
    },
  };
}

describe('AcpTurnDriver handshake', () => {
  it('opens with initialize, declining the fs and terminal capabilities', () => {
    const h = harness();
    const init = h.sentMethod('initialize');
    expect(init).toBeDefined();
    expect(init?.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'geniro', version: '1.2.3' },
    });
  });

  it('creates a session and prompts it, emitting the session id', () => {
    const h = harness();
    expect(h.feed(initializeReply(1))).toEqual([]);
    const newSession = h.sentMethod('session/new');
    expect(newSession?.params).toEqual({ cwd: '/work', mcpServers: [] });

    const events = h.feed({ id: 2, result: { sessionId: 'sess-1' } });
    expect(events).toEqual([{ type: 'session', sessionId: 'sess-1' }]);
    expect(h.sentMethod('session/prompt')?.params).toEqual({
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: 'do the thing' }],
    });
  });

  it('reports a failure when the agent returns a session with no id', () => {
    const h = harness();
    h.feed(initializeReply(1));
    expect(h.feed({ id: 2, result: {} })).toEqual([
      {
        type: 'error',
        message: 'acp session failed: the agent returned no session id',
      },
    ]);
    expect(h.sentMethod('session/prompt')).toBeUndefined();
  });

  it('surfaces an initialize error as a turn error', () => {
    const h = harness();
    expect(h.feed({ id: 1, error: { code: -32603, message: 'boom' } })).toEqual(
      [{ type: 'error', message: 'acp initialize failed: boom' }],
    );
  });

  it('emits an error when the opening frame cannot be written', () => {
    const h = harness({}, false);
    expect(h.emitted).toEqual([
      {
        type: 'error',
        message: "acp: failed to send initialize (the agent's stdin is closed)",
      },
    ]);
  });

  it('notes a protocol version the client does not implement', () => {
    const h = harness();
    const events = h.feed({ id: 1, result: { protocolVersion: 99 } });
    expect(events).toContainEqual({
      type: 'notice',
      message:
        'agent negotiated ACP protocol version 99; this client implements 1',
    });
  });

  it('ignores a reply to an id it never sent', () => {
    const h = harness();
    expect(h.feed({ id: 999, result: {} })).toEqual([]);
  });
});

describe('AcpTurnDriver MCP delivery', () => {
  const endpoint = {
    input: {
      ...BASE_INPUT,
      mcpEndpoint: {
        url: 'http://127.0.0.1:1/v1/mcp/r/n',
        token: 'tok-1',
        serverName: 'geniro-run12345',
      },
    },
  };

  /** A caller turn: a role, plus the awareness block naming its callees. */
  const caller = {
    input: {
      ...endpoint.input,
      systemPrompt: 'You orchestrate.',
      callSurfacePrompt: 'May call (via the call_agent tool): - Helper',
    },
  };

  function promptText(h: Harness): string {
    const params = h.sentMethod('session/prompt')?.params as
      { prompt: { text: string }[] } | undefined;
    return params?.prompt[0]?.text ?? '';
  }

  it('carries the call endpoint in session/new when the agent advertises HTTP MCP', () => {
    const h = harness(endpoint);
    h.feed(initializeReply(1, { http: true }));
    expect(h.sentMethod('session/new')?.params).toEqual({
      cwd: '/work',
      mcpServers: [
        {
          type: 'http',
          name: 'geniro-run12345',
          url: 'http://127.0.0.1:1/v1/mcp/r/n',
          headers: [{ name: 'Authorization', value: 'Bearer tok-1' }],
        },
      ],
    });
  });

  it('degrades visibly, without the endpoint, when HTTP MCP is not advertised', () => {
    const h = harness(endpoint);
    const events = h.feed(initializeReply(1, { http: false }));
    expect(events).toContainEqual({
      type: 'notice',
      message:
        'agent calls disabled for this turn: the agent does not advertise HTTP MCP support (mcpCapabilities.http), so the callee list was removed from this turn’s instructions too',
    });
    expect(h.sentMethod('session/new')?.params).toEqual({
      cwd: '/work',
      mcpServers: [],
    });
  });

  it('keeps the callee list in the prompt when the call tools were registered', () => {
    const h = harness(caller);
    h.feed(initializeReply(1, { http: true }));
    h.feed({ id: 2, result: { sessionId: 's' } });
    expect(promptText(h)).toBe(
      'You orchestrate.\n\nMay call (via the call_agent tool): - Helper\n\ndo the thing',
    );
  });

  it('drops the callee list from the prompt when the call tools were withheld', () => {
    const h = harness(caller);
    h.feed(initializeReply(1, { http: false }));
    h.feed({ id: 2, result: { sessionId: 's' } });
    // Telling an agent to route work through `call_agent` when no such tool is
    // registered makes its callees silently never run while the node still
    // reports success. The role survives; only the false affordance goes.
    expect(promptText(h)).toBe('You orchestrate.\n\ndo the thing');
    expect(promptText(h)).not.toContain('call_agent');
  });

  it('prepends a graph node role to the prompt, ACP having no system-prompt field', () => {
    const h = harness({ input: { ...BASE_INPUT, systemPrompt: 'Be terse.' } });
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 's' } });
    expect(promptText(h)).toBe('Be terse.\n\ndo the thing');
  });

  it('sends no server list when the turn has no endpoint', () => {
    const h = harness();
    h.feed(initializeReply(1, { http: true }));
    expect(h.sentMethod('session/new')?.params).toEqual({
      cwd: '/work',
      mcpServers: [],
    });
  });
});

describe('AcpTurnDriver session resume', () => {
  const resuming = { input: { ...BASE_INPUT, resumeSessionId: 'prior-7' } };

  it('loads the prior session when the agent supports it', () => {
    const h = harness(resuming);
    h.feed(initializeReply(1, { loadSession: true }));
    expect(h.sentMethod('session/load')?.params).toEqual({
      sessionId: 'prior-7',
      cwd: '/work',
      mcpServers: [],
    });
    expect(h.sentMethod('session/new')).toBeUndefined();
  });

  it('stops re-sending the host preamble once the session has replayed it', () => {
    // Prompt text IS the conversation on this transport: one turn is one
    // process, the next `session/load`s the stored session, so every block a
    // turn prepends is replayed to every turn after it. Re-sending the ~1.1KB
    // preamble each time put ~40 copies inside a 40-message thread's window.
    // A load has already replayed it, so the driver asks for it to be dropped.
    const seen: boolean[] = [];
    const h = harness({
      ...resuming,
      composeSystemPrompt: (granted, includePreamble) => {
        seen.push(includePreamble);
        return includePreamble ? 'PREAMBLE\n\nROLE' : 'ROLE';
      },
    });
    h.feed(initializeReply(1, { loadSession: true }));
    h.feed({ jsonrpc: '2.0', id: 2, result: {} });

    // The composition ran for a RESUMED session and was told to omit it.
    expect(seen).toContain(false);
    const prompt = h.sentMethod('session/prompt')?.params as {
      prompt: { text: string }[];
    };
    expect(prompt.prompt[0]?.text).not.toContain('PREAMBLE');
    expect(prompt.prompt[0]?.text).toContain('ROLE');
  });

  it('still sends the preamble on a session that was NOT resumed', () => {
    // The control: a fresh `session/new` has replayed nothing, so withholding
    // it there would leave that agent never told where its words land.
    const seen: boolean[] = [];
    const h = harness({
      composeSystemPrompt: (granted, includePreamble) => {
        seen.push(includePreamble);
        return includePreamble ? 'PREAMBLE\n\nROLE' : 'ROLE';
      },
    });
    h.feed(initializeReply(1));
    h.feed({ jsonrpc: '2.0', id: 2, result: { sessionId: 'fresh-1' } });

    expect(seen).not.toContain(false);
    const prompt = h.sentMethod('session/prompt')?.params as {
      prompt: { text: string }[];
    };
    expect(prompt.prompt[0]?.text).toContain('PREAMBLE');
  });

  it('drops the replayed transcript a session/load streams back', () => {
    const h = harness(resuming);
    h.feed(initializeReply(1, { loadSession: true }));

    // Everything between the load request and its reply is history already in
    // SQLite; persisting it again would duplicate the whole thread per turn.
    expect(h.feed(chunk('agent_message_chunk', 'an old answer'))).toEqual([]);
    expect(
      h.feed(
        update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read' }),
      ),
    ).toEqual([]);

    // The load reply carries no session id — the id is the one we sent.
    expect(h.feed({ id: 2, result: {} })).toEqual([
      { type: 'session', sessionId: 'prior-7' },
    ]);
    // ...and live output after the reply flows normally.
    expect(h.feed(chunk('agent_message_chunk', 'a new answer'))).toEqual([
      { type: 'text_delta', text: 'a new answer' },
    ]);
  });

  it('measures what the session/load replay cost before the prompt could be sent', () => {
    const debug = vi.fn();
    const h = harness({ ...resuming, logger: { warn: vi.fn(), debug } });
    h.feed(initializeReply(1, { loadSession: true }));

    h.feed(chunk('agent_message_chunk', 'an old answer'));
    h.feed(
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read' }),
    );
    h.feed(chunk('agent_message_chunk', 'another old answer'));
    // Nothing is reported until the load reply lands — that is the point the
    // prompt is unblocked, so that is what the measurement bounds.
    expect(debug).not.toHaveBeenCalled();

    h.feed({ id: 2, result: {} });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0]?.[0]).toContain('replayed 3 update(s)');
  });

  it('notices when the agent does not offer the mode this turn asked for', () => {
    const h = harness({ preferredModeId: 'plan' });
    h.feed(initializeReply(1));
    const events = h.feed({
      id: 2,
      result: {
        sessionId: 's',
        modes: { currentModeId: 'normal', availableModes: [{ id: 'normal' }] },
      },
    });

    // A `plan` turn that quietly ran under the agent's normal mode has write
    // access the user believed they had turned off — the one degrade here that
    // costs something, so it must not be silent.
    expect(events).toContainEqual({
      type: 'notice',
      message:
        "agent does not offer the 'plan' mode — this turn runs under the agent's current mode instead",
    });
    // The turn still runs; the notice reports, it does not abort.
    expect(h.sentMethod('session/prompt')).toBeDefined();
    expect(h.sentMethod('session/set_mode')).toBeUndefined();
  });

  it('sets the mode without a notice when the agent does offer it', () => {
    const h = harness({ preferredModeId: 'plan' });
    h.feed(initializeReply(1));
    const events = h.feed({
      id: 2,
      result: {
        sessionId: 's',
        modes: {
          currentModeId: 'normal',
          availableModes: [{ id: 'normal' }, { id: 'plan' }],
        },
      },
    });

    expect(h.sentMethod('session/set_mode')?.params).toEqual({
      sessionId: 's',
      modeId: 'plan',
    });
    expect(events.filter((e) => e.type === 'notice')).toEqual([]);
  });

  it('never claims the agent lacks a mode from a reply that enumerated none', () => {
    const h = harness({
      input: { ...BASE_INPUT, resumeSessionId: 'prior-7' },
      preferredModeId: 'plan',
    });
    h.feed(initializeReply(1, { loadSession: true }));
    // Silence is not a refusal: reading a missing `modes` block as "not offered"
    // would put a false statement about the agent into the transcript. (A real
    // `session/load` reply DOES carry modes — measured on 2026.08.11-e8db854 —
    // so this is the shape a future build could still send, not the normal one.)
    const events = h.feed({ id: 2, result: {} });

    expect(
      events.filter(
        (e) => e.type === 'notice' && e.message.includes('does not offer'),
      ),
    ).toEqual([]);
  });

  it('applies the mode and model a session/load reply enumerates, like a fresh one', () => {
    // The measured shape of a real load reply on 2026.08.11-e8db854: `modes`,
    // `models` and a full `configOptions` list with each option's currentValue.
    // Recorded here because it was previously believed to carry none of them,
    // which is what made a resumed turn look like it needed its own rules.
    const h = harness({
      input: { ...BASE_INPUT, resumeSessionId: 'prior-7', model: 'opus-5' },
      preferredModeId: 'plan',
    });
    h.feed(initializeReply(1, { loadSession: true }));

    h.feed({
      id: 2,
      result: {
        modes: {
          currentModeId: 'agent',
          availableModes: [{ id: 'agent' }, { id: 'plan' }],
        },
        models: { currentModelId: 'sonnet-5', availableModels: [] },
        configOptions: [
          {
            id: 'model',
            category: 'model',
            currentValue: 'sonnet-5',
            availableValues: [{ value: 'opus-5' }, { value: 'sonnet-5' }],
          },
        ],
      },
    });

    expect(h.sentMethod('session/set_mode')?.params).toEqual({
      sessionId: 'prior-7',
      modeId: 'plan',
    });
    expect(h.sentMethod('session/set_config_option')?.params).toEqual({
      sessionId: 'prior-7',
      configId: 'model',
      value: 'opus-5',
    });
  });

  it('runs the turn on a FRESH session when the agent cannot reopen the thread', () => {
    // The dead end this replaces: a refused load ended the turn, and since every
    // later turn resumes the same id, the chat was unusable for good — the user
    // saw a turn finish instantly having written nothing. Measured refusal shape
    // on 2026.08.11-e8db854: `-32602 Invalid params`, "Session … not found".
    const h = harness(resuming);
    h.feed(initializeReply(1, { loadSession: true }));

    const events = h.feed({
      id: 2,
      error: { code: -32602, message: 'Invalid params' },
    });

    expect(events).toContainEqual({
      type: 'notice',
      message:
        'agent could not reopen this conversation (Invalid params) — this turn runs on a fresh session, without the earlier history in its context',
    });
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(h.sentMethod('session/new')?.params).toEqual({
      cwd: '/work',
      mcpServers: [],
    });
  });

  it('un-arms the replay drop after a failed load, so the new turn is not swallowed', () => {
    // The load set `replaying`, and every transcript update is dropped while it
    // is set. Leave it armed and the fresh session's whole answer vanishes —
    // which turns "lost the history" into "wrote nothing at all", the very
    // symptom the degrade exists to end.
    const h = harness(resuming);
    h.feed(initializeReply(1, { loadSession: true }));
    h.feed({ id: 2, error: { code: -32602, message: 'Invalid params' } });
    h.feed({ id: 3, result: { sessionId: 'fresh-1' } });

    expect(h.feed(chunk('agent_message_chunk', 'a new answer'))).toEqual([
      { type: 'text_delta', text: 'a new answer' },
    ]);
    expect(h.sentMethod('session/prompt')?.params).toEqual({
      sessionId: 'fresh-1',
      prompt: [{ type: 'text', text: 'do the thing' }],
    });
  });

  it('carries the call surface into the fresh session a failed load falls back to', () => {
    // The MCP servers were granted during `initialize`; a fallback that dropped
    // them would silently withhold the agent-call tools for that turn while its
    // instructions still named the callees.
    const h = harness({
      input: {
        ...BASE_INPUT,
        resumeSessionId: 'prior-7',
        mcpEndpoint: {
          url: 'http://127.0.0.1:1/v1/mcp/r/n',
          token: 'tok',
          serverName: 'geniro-r',
        },
      },
    });
    h.feed(initializeReply(1, { loadSession: true, http: true }));
    h.feed({ id: 2, error: { code: -32602, message: 'Invalid params' } });

    expect(h.sentMethod('session/new')?.params).toEqual({
      cwd: '/work',
      mcpServers: [
        {
          type: 'http',
          name: 'geniro-r',
          url: 'http://127.0.0.1:1/v1/mcp/r/n',
          headers: [{ name: 'Authorization', value: 'Bearer tok' }],
        },
      ],
    });
  });

  it('shows a stubbed permission request the arguments its tool_call announced', () => {
    const h = harness();
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 's' } });
    h.feed(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't-1',
        name: 'write_file',
        kind: 'edit',
        rawInput: { path: 'a.ts', contents: 'x' },
      }),
    );

    // The request's own toolCall is a stub: no name, no kind, no rawInput.
    // Without the cache the user is asked to approve a blank tool with no
    // visible arguments.
    const events = h.feed({
      id: 'p1',
      method: 'session/request_permission',
      params: { toolCall: { toolCallId: 't-1' }, options: [] },
    });
    expect(events).toEqual([
      {
        type: 'approval_request',
        id: expect.any(String) as unknown as string,
        toolName: 'write_file',
        input: { path: 'a.ts', contents: 'x' },
      },
    ]);
  });

  it('measures nothing on a fresh session, which has no replay to pay for', () => {
    const debug = vi.fn();
    const h = harness({ input: BASE_INPUT, logger: { warn: vi.fn(), debug } });
    h.feed(initializeReply(1, { loadSession: true }));
    h.feed({ id: 2, result: { sessionId: 's' } });
    expect(debug).not.toHaveBeenCalled();
  });

  it('still harvests the command set and the context usage during that replay', () => {
    const h = harness(resuming);
    h.feed(initializeReply(1, { loadSession: true }));

    // Unlike the replayed transcript, these two describe CURRENT state — the
    // set of commands this session can invoke now, and how full its context
    // is — so the replay window must not swallow them the way it swallows
    // history.
    expect(
      h.feed(
        update({
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'review' }],
        }),
      ),
    ).toEqual([
      {
        type: 'slash_commands',
        commands: [{ name: 'review', description: null }],
      },
    ]);
    h.feed(
      update({
        sessionUpdate: 'usage_update',
        used: 12_345,
        size: 200_000,
        cost: { amount: 0.5, currency: 'USD' },
      }),
    );

    h.feed({ id: 2, result: {} });
    const [event] = h.feed({ id: 3, result: { stopReason: 'end_turn' } });
    expect(event).toMatchObject({
      type: 'turn_complete',
      usage: { contextTokens: 12_345, costUsd: 0.5 },
    });
  });

  it('says so when resume was asked for but the agent cannot load sessions', () => {
    const h = harness(resuming);
    const events = h.feed(initializeReply(1, { loadSession: false }));
    expect(events).toContainEqual({
      type: 'notice',
      message:
        'agent does not support session/load — this turn starts a fresh session instead of resuming',
    });
    expect(h.sentMethod('session/new')).toBeDefined();
  });
});

describe('AcpTurnDriver model selection', () => {
  const WANTED = 'claude-opus-5[thinking=true]';
  const wanting = { input: { ...BASE_INPUT, model: WANTED } };

  function sessionWithModels(
    current: string,
    available: string[],
  ): Record<string, unknown> {
    return {
      sessionId: 's-1',
      models: {
        currentModelId: current,
        availableModels: available.map((modelId) => ({
          modelId,
          name: modelId,
        })),
      },
    };
  }

  /** Frame order, so "before the prompt" can be asserted rather than assumed. */
  function methodsOf(h: ReturnType<typeof harness>): string[] {
    return h.sent
      .map((frame) => frame.method)
      .filter((method): method is string => typeof method === 'string');
  }

  /** Notices the driver RETURNED — `onMessage`'s value, not the emit channel. */
  function noticesIn(events: AgentEvent[]): AgentEvent[] {
    return events.filter((event) => event.type === 'notice');
  }

  it('sets an offered model BEFORE the prompt goes out', () => {
    // Order is the whole mechanism: both frames ride one ordered stdio stream,
    // so a set_model sent after the prompt would apply to the NEXT turn.
    const h = harness(wanting);
    h.feed(initializeReply(1));
    const events = h.feed({
      id: 2,
      result: sessionWithModels('composer-2.5', [WANTED]),
    });

    expect(h.sentMethod('session/set_model')?.params).toEqual({
      sessionId: 's-1',
      modelId: WANTED,
    });
    const methods = methodsOf(h);
    expect(methods.indexOf('session/set_model')).toBeLessThan(
      methods.indexOf('session/prompt'),
    );
    expect(noticesIn(events)).toEqual([]);
  });

  it('spends no frame when the session is already on that model', () => {
    const h = harness(wanting);
    h.feed(initializeReply(1));
    const events = h.feed({
      id: 2,
      result: sessionWithModels(WANTED, [WANTED]),
    });

    expect(h.sentMethod('session/set_model')).toBeUndefined();
    expect(noticesIn(events)).toEqual([]);
  });

  it('says so, and sends nothing, when a FRESH session does not offer it', () => {
    // The local refusal is worth it here because the reply genuinely lists
    // what is on offer — asking anyway would spend a round-trip to be refused.
    const h = harness(wanting);
    h.feed(initializeReply(1));
    const events = h.feed({
      id: 2,
      result: sessionWithModels('composer-2.5', ['gpt-5.2']),
    });

    expect(h.sentMethod('session/set_model')).toBeUndefined();
    expect(events).toContainEqual({
      type: 'notice',
      message: `agent does not offer the model '${WANTED}' — this turn runs on the agent's current model instead`,
    });
  });

  it('still asks on a RESUMED session, whose reply lists no models', () => {
    // The regression this pins: gating a resumed turn on the offers check
    // refuses locally on EVERY turn after a chat's first — cursor cannot keep
    // its process, so they all resume — leaving the model unapplied for the
    // whole conversation and landing a degrade row per turn.
    const h = harness({
      input: { ...BASE_INPUT, model: WANTED, resumeSessionId: 'prior-7' },
    });
    h.feed(initializeReply(1, { loadSession: true }));
    const events = h.feed({ id: 2, result: {} });

    expect(h.sentMethod('session/set_model')?.params).toEqual({
      sessionId: 'prior-7',
      modelId: WANTED,
    });
    expect(noticesIn(events)).toEqual([]);
  });

  it('reports the agent’s OWN refusal rather than assuming one', () => {
    const h = harness({
      input: { ...BASE_INPUT, model: WANTED, resumeSessionId: 'prior-7' },
    });
    h.feed(initializeReply(1, { loadSession: true }));
    h.feed({ id: 2, result: {} });
    const setModelId = h.sent.find(
      (frame) => frame.method === 'session/set_model',
    )?.id;

    const events = h.feed({
      id: setModelId,
      error: { code: -32602, message: 'Invalid model value' },
    });

    expect(events).toEqual([
      {
        type: 'notice',
        message: `agent declined model '${WANTED}': Invalid model value — this turn runs on the agent's current model`,
      },
    ]);
  });

  it('leaves a turn that named no model alone', () => {
    const h = harness();
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: sessionWithModels('composer-2.5', [WANTED]) });

    expect(h.sentMethod('session/set_model')).toBeUndefined();
  });

  describe('when the reply enumerates nothing', () => {
    // Silence is not a refusal. `readAcpModels`' own contract says an empty
    // result means "the agent said nothing", and that EVERY caller must read it
    // as unknown — so refusing locally here would run the turn on a model the
    // user did not pick while asserting something the agent never said.
    const refused = {
      type: 'notice',
      message: `agent does not offer the model '${WANTED}' — this turn runs on the agent's current model instead`,
    };

    function fresh(result: Record<string, unknown>): {
      sent: Record<string, unknown> | undefined;
      events: AgentEvent[];
    } {
      const h = harness(wanting);
      h.feed(initializeReply(1));
      const events = h.feed({ id: 2, result });
      return { sent: h.sentMethod('session/set_model'), events };
    }

    it('asks anyway when a fresh reply carries no models block', () => {
      const { sent, events } = fresh({ sessionId: 's-1' });

      expect(sent?.params).toEqual({ sessionId: 's-1', modelId: WANTED });
      expect(events).not.toContainEqual(refused);
    });

    it('asks anyway when the block names a current model but no list', () => {
      const { sent, events } = fresh({
        sessionId: 's-1',
        models: { currentModelId: 'composer-2.5' },
      });

      expect(sent?.params).toEqual({ sessionId: 's-1', modelId: WANTED });
      expect(events).not.toContainEqual(refused);
    });
  });

  describe('over the ACP 1.0 config-option carrier', () => {
    /** A `session/new` reply that enumerates models the ACP 1.0 way. */
    function sessionWithConfigOptions(
      current: string,
      available: string[],
    ): Record<string, unknown> {
      return {
        sessionId: 's-1',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: current,
            options: available.map((value) => ({ value, name: value })),
          },
        ],
      };
    }

    it('sets the model with session/set_config_option, not session/set_model', () => {
      // ACP removed `session/set_model` at schema v1.16.0. An agent that
      // enumerated its models under `configOptions` is one that implements the
      // replacement, so sending the removed method would be a refused frame
      // and a degrade notice for a model the agent was perfectly able to use.
      const h = harness(wanting);
      h.feed(initializeReply(1));
      const events = h.feed({
        id: 2,
        result: sessionWithConfigOptions('composer-2.5', [WANTED]),
      });

      expect(h.sentMethod('session/set_config_option')?.params).toEqual({
        sessionId: 's-1',
        // `configId`, NOT the `configOptionId` the docs' prose uses — probed
        // on cursor-agent 2026.08.04, which rejects the latter as invalid.
        configId: 'model',
        value: WANTED,
      });
      expect(h.sentMethod('session/set_model')).toBeUndefined();
      expect(noticesIn(events)).toEqual([]);
    });

    it('still puts it before the prompt', () => {
      const h = harness(wanting);
      h.feed(initializeReply(1));
      h.feed({
        id: 2,
        result: sessionWithConfigOptions('composer-2.5', [WANTED]),
      });

      const methods = methodsOf(h);
      expect(methods.indexOf('session/set_config_option')).toBeLessThan(
        methods.indexOf('session/prompt'),
      );
    });

    it('keeps the legacy frame for an agent that offers no model option', () => {
      // Removal from the SPEC is not removal from the binaries. An agent
      // predating v1.16.0 enumerates under `models` and answers only
      // `session/set_model`.
      const h = harness(wanting);
      h.feed(initializeReply(1));
      h.feed({ id: 2, result: sessionWithModels('composer-2.5', [WANTED]) });

      expect(h.sentMethod('session/set_model')?.params).toEqual({
        sessionId: 's-1',
        modelId: WANTED,
      });
      expect(h.sentMethod('session/set_config_option')).toBeUndefined();
    });

    it('refuses locally against a config-option list that omits the model', () => {
      const h = harness(wanting);
      h.feed(initializeReply(1));
      const events = h.feed({
        id: 2,
        result: sessionWithConfigOptions('composer-2.5', ['gpt-5.2']),
      });

      expect(h.sentMethod('session/set_config_option')).toBeUndefined();
      expect(events).toContainEqual({
        type: 'notice',
        message: `agent does not offer the model '${WANTED}' — this turn runs on the agent's current model instead`,
      });
    });

    describe('a model parameter the current model does not take', () => {
      /**
       * A `session/new` reply shaped like cursor's own: the model option, plus
       * the model's parameters as their own entries under the agent's
       * categories. Values measured on cursor-agent 2026.08.11-e8db854 —
       * `grok-4.6` offers `low|medium|high|xhigh` and no `max`.
       */
      function sessionOffering(
        currentModel: string,
        effortValues: string[] | null,
      ): Record<string, unknown> {
        return {
          sessionId: 's-1',
          configOptions: [
            {
              id: 'model',
              category: 'model',
              currentValue: currentModel,
              options: [{ value: currentModel, name: currentModel }],
            },
            ...(effortValues === null
              ? []
              : [
                  {
                    id: 'effort',
                    category: 'thought_level',
                    currentValue: 'high',
                    options: effortValues.map((value) => ({
                      value,
                      name: value,
                    })),
                  },
                ]),
          ],
        };
      }

      /** A turn already on `grok-4.6`, asking for an effort with it. */
      function turnOn(
        model: string,
        effort: string,
      ): Partial<AcpDriverOptions> {
        return {
          input: { ...BASE_INPUT, model },
          modelSelection: {
            model,
            parameters: [
              // The shape `cursorModelSelection` really produces — every
              // spelling of the axis, so the driver can resolve it.
              {
                id: 'effort',
                value: effort,
                alternateIds: ['effort', 'reasoning'],
              },
            ],
          },
        };
      }

      it('says so, and sends nothing, rather than being refused for it', () => {
        // The report: a cursor chat on Grok with the effort chip left at `max`
        // opened every turn with a red SYSTEM row reading `agent declined model
        // setting 'effort=max': Invalid params` — and then worked normally. The
        // chip is remembered per CLI and `max` is real on `claude-opus-5`, so
        // pointing that chat at Grok asks for a value that model has never had.
        const h = harness(turnOn('grok-4.6', 'max'));
        h.feed(initializeReply(1));
        const events = h.feed({
          id: 2,
          result: sessionOffering('grok-4.6', [
            'low',
            'medium',
            'high',
            'xhigh',
          ]),
        });

        // Not sent at all: the reply on hand describes the model this turn runs
        // on, so the round-trip could only come back refused.
        expect(
          h.sent.filter(
            (frame) =>
              frame.method === 'session/set_config_option' &&
              (frame.params as { configId?: string }).configId === 'effort',
          ),
        ).toEqual([]);
        expect(noticesIn(events)).toEqual([
          {
            type: 'notice',
            severity: 'warning',
            message:
              "this model does not offer 'effort=max' — the turn runs at 'high' (it offers low, medium, high, xhigh)",
          },
        ]);
      });

      it('says it plainly when the model has no such setting at all', () => {
        // `auto-smart` and `composer-2.5` enumerate no `effort` option; the
        // agent's own words for the frame are `Unknown model config option`.
        const h = harness(turnOn('auto-smart', 'max'));
        h.feed(initializeReply(1));
        const events = h.feed({
          id: 2,
          result: sessionOffering('auto-smart', null),
        });

        expect(noticesIn(events)).toEqual([
          {
            type: 'notice',
            severity: 'warning',
            message:
              "this model has no 'effort' setting — the turn runs without it",
          },
        ]);
      });

      it('sends a value the model DOES offer, with no notice', () => {
        const h = harness(turnOn('grok-4.6', 'xhigh'));
        h.feed(initializeReply(1));
        const events = h.feed({
          id: 2,
          result: sessionOffering('grok-4.6', [
            'low',
            'medium',
            'high',
            'xhigh',
          ]),
        });

        expect(
          h.sent.find(
            (frame) =>
              frame.method === 'session/set_config_option' &&
              (frame.params as { configId?: string }).configId === 'effort',
          )?.params,
        ).toEqual({ sessionId: 's-1', configId: 'effort', value: 'xhigh' });
        expect(noticesIn(events)).toEqual([]);
      });

      it('still ASKS when the turn is switching models', () => {
        // The reply describes the model being switched away from, so it says
        // nothing about the one this turn will run on. Deferring the prompt
        // behind the model reply would make it checkable and was measured to
        // cost ~1.4s per turn — the agent does not serialize the switch against
        // the prompt (first session/update at ~1.6s pipelined vs ~3.0s
        // deferred, cursor-agent 2026.08.11-e8db854).
        const h = harness(turnOn('claude-opus-5', 'max'));
        h.feed(initializeReply(1));
        const events = h.feed({
          id: 2,
          result: {
            sessionId: 's-1',
            configOptions: [
              {
                id: 'model',
                category: 'model',
                currentValue: 'grok-4.6',
                options: [
                  { value: 'grok-4.6', name: 'grok' },
                  { value: 'claude-opus-5', name: 'opus' },
                ],
              },
              // Grok's list, which does NOT contain `max` — and must not be
              // read as the incoming model's.
              {
                id: 'effort',
                category: 'thought_level',
                currentValue: 'high',
                options: ['low', 'medium', 'high', 'xhigh'].map((value) => ({
                  value,
                  name: value,
                })),
              },
            ],
          },
        });

        expect(
          h.sent.find(
            (frame) =>
              frame.method === 'session/set_config_option' &&
              (frame.params as { configId?: string }).configId === 'effort',
          )?.params,
        ).toEqual({ sessionId: 's-1', configId: 'effort', value: 'max' });
        expect(noticesIn(events)).toEqual([]);
      });

      it('sends the spelling THIS model uses, not the one it was handed', () => {
        // One axis, two names, and the model decides which: measured on
        // cursor-agent 2026.08.11-e8db854, `gpt-5.2` enumerates `reasoning`
        // where `grok-4.6` enumerates `effort`, and the wrong name is
        // `-32602 Unknown model config option`. So the OpenAI-family models had
        // an effort picker that could never have applied anything.
        const h = harness({
          input: { ...BASE_INPUT, model: 'gpt-5.2' },
          modelSelection: {
            model: 'gpt-5.2',
            parameters: [
              {
                id: 'effort',
                value: 'high',
                alternateIds: ['effort', 'reasoning'],
              },
            ],
          },
        });
        h.feed(initializeReply(1));
        const events = h.feed({
          id: 2,
          result: {
            sessionId: 's-1',
            configOptions: [
              {
                id: 'model',
                category: 'model',
                currentValue: 'gpt-5.2',
                options: [{ value: 'gpt-5.2', name: 'GPT-5.2' }],
              },
              {
                id: 'reasoning',
                category: 'thought_level',
                currentValue: 'medium',
                options: ['low', 'medium', 'high', 'extra-high'].map(
                  (value) => ({ value, name: value }),
                ),
              },
            ],
          },
        });

        expect(
          h.sent.find((frame) => frame.method === 'session/set_config_option')
            ?.params,
        ).toEqual({ sessionId: 's-1', configId: 'reasoning', value: 'high' });
        expect(noticesIn(events)).toEqual([]);
      });

      it('keeps the id it was handed when the model offers no other spelling', () => {
        // The ordinary case, and the guard against the resolution above turning
        // into a guess: `grok-4.6` has `effort`, so `effort` is what goes out.
        const h = harness(turnOn('grok-4.6', 'xhigh'));
        h.feed(initializeReply(1));
        h.feed({
          id: 2,
          result: sessionOffering('grok-4.6', [
            'low',
            'medium',
            'high',
            'xhigh',
          ]),
        });

        expect(
          h.sent.find((frame) => frame.method === 'session/set_config_option')
            ?.params,
        ).toEqual({ sessionId: 's-1', configId: 'effort', value: 'xhigh' });
      });

      it('asks anyway when the agent enumerated no options at all', () => {
        // Silence is not a refusal — the same contract the model check obeys.
        // Reading it as one would drop every parameter on a pre-1.0 transport.
        const h = harness(turnOn('grok-4.6', 'max'));
        h.feed(initializeReply(1));
        const events = h.feed({
          id: 2,
          result: { sessionId: 's-1', models: { currentModelId: 'grok-4.6' } },
        });

        expect(
          h.sent.find(
            (frame) =>
              frame.method === 'session/set_config_option' &&
              (frame.params as { configId?: string }).configId === 'effort',
          )?.params,
        ).toEqual({ sessionId: 's-1', configId: 'effort', value: 'max' });
        expect(noticesIn(events)).toEqual([]);
      });
    });

    it('reports a refused set_config_option as the same model degrade', () => {
      // The user asked to run on a model; which frame carried that request is
      // not something they should have to learn from the failure line.
      const h = harness(wanting);
      h.feed(initializeReply(1));
      h.feed({
        id: 2,
        result: sessionWithConfigOptions('composer-2.5', [WANTED]),
      });
      const sentId = h.sent.find(
        (frame) => frame.method === 'session/set_config_option',
      )?.id;

      const events = h.feed({
        id: sentId,
        error: { code: -32602, message: 'Invalid model value' },
      });

      expect(events).toEqual([
        {
          type: 'notice',
          message: `agent declined model '${WANTED}': Invalid model value — this turn runs on the agent's current model`,
        },
      ]);
    });
  });
});

describe('AcpTurnDriver session modes', () => {
  function sessionWithModes(current: string, available: string[]): unknown {
    return {
      id: 2,
      result: {
        sessionId: 's',
        modes: {
          currentModeId: current,
          availableModes: available.map((id) => ({ id, name: id })),
        },
      },
    };
  }

  it('requests the preferred mode when the agent offers it', () => {
    const h = harness({ preferredModeId: 'plan' });
    h.feed(initializeReply(1));
    h.feed(sessionWithModes('agent', ['agent', 'plan']));
    expect(h.sentMethod('session/set_mode')?.params).toEqual({
      sessionId: 's',
      modeId: 'plan',
    });
  });

  it('spends no round-trip when the mode is absent or already current', () => {
    const absent = harness({ preferredModeId: 'plan' });
    absent.feed(initializeReply(1));
    absent.feed(sessionWithModes('agent', ['agent']));
    expect(absent.sentMethod('session/set_mode')).toBeUndefined();

    const already = harness({ preferredModeId: 'plan' });
    already.feed(initializeReply(1));
    already.feed(sessionWithModes('plan', ['agent', 'plan']));
    expect(already.sentMethod('session/set_mode')).toBeUndefined();
  });

  it('degrades a refused mode to a notice rather than failing the turn', () => {
    const h = harness({ preferredModeId: 'plan' });
    h.feed(initializeReply(1));
    h.feed(sessionWithModes('agent', ['agent', 'plan']));
    const events = h.feed({ id: 3, error: { code: -32602, message: 'no' } });
    expect(events).toEqual([
      {
        type: 'notice',
        // `warning`, not the default: "a degrade, not a failure" is what this
        // arm's own comment has always said, and the severity is what finally
        // keeps the renderer from drawing it as a failed turn.
        severity: 'warning',
        message: "agent declined session mode 'plan': no",
      },
    ]);
  });
});

/** A `session/update` notification wrapping one update payload. */
function update(payload: Record<string, unknown>): unknown {
  return {
    method: 'session/update',
    params: { sessionId: 's', update: payload },
  };
}

function chunk(kind: string, text: string): unknown {
  return update({ sessionUpdate: kind, content: { type: 'text', text } });
}

describe('AcpTurnDriver session updates', () => {
  it('streams a message chunk as an ephemeral delta, not a transcript row', () => {
    const h = harness();
    // `text_delta` is EPHEMERAL by contract; `text` is the durable row. A
    // chunk must be the former, or every word of a reply becomes its own row.
    expect(h.feed(chunk('agent_message_chunk', 'hello'))).toEqual([
      { type: 'text_delta', text: 'hello' },
    ]);
  });

  it('closes the answer block and opens a thought block when the agent switches', () => {
    const h = harness();
    h.feed(chunk('agent_message_chunk', 'hello'));
    // The switch is the boundary: the answer is written as one row, and the
    // thought starts a new one rather than merging into it.
    expect(h.feed(chunk('agent_thought_chunk', 'hmm'))).toEqual([
      { type: 'text', text: 'hello' },
    ]);
    expect(h.feed(chunk('agent_message_chunk', 'done'))).toEqual([
      { type: 'reasoning', text: 'hmm' },
      { type: 'text_delta', text: 'done' },
    ]);
  });

  it('closes the open block before a tool call, keeping the interleaving', () => {
    const h = harness();
    h.feed(chunk('agent_message_chunk', 'let me look'));
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 't-9',
          title: 'Read',
        }),
      ),
    ).toEqual([
      { type: 'text', text: 'let me look' },
      { type: 'tool_call', id: 't-9', name: 'Read', input: null },
    ]);
  });

  it('ignores a non-text content block instead of emitting an empty row', () => {
    const h = harness();
    expect(
      h.feed(
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'image', data: 'x' },
        }),
      ),
    ).toEqual([]);
  });

  it('maps a tool call and carries its name onto the result', () => {
    const h = harness();
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 't-1',
          name: 'read_file',
          title: 'Read file',
          rawInput: { path: 'a.ts' },
        }),
      ),
    ).toEqual([
      {
        type: 'tool_call',
        id: 't-1',
        name: 'read_file',
        input: { path: 'a.ts' },
      },
    ]);

    // The update carries no name — the driver supplies the one it recorded.
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 't-1',
          status: 'completed',
          rawOutput: { text: 'ok' },
        }),
      ),
    ).toEqual([
      {
        type: 'tool_result',
        id: 't-1',
        name: 'read_file',
        result: { text: 'ok' },
        isError: false,
      },
    ]);
  });

  it('falls back to the title when a tool call reports no machine name', () => {
    const h = harness();
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 't-2',
          title: 'Run tests',
        }),
      ),
    ).toEqual([
      { type: 'tool_call', id: 't-2', name: 'Run tests', input: null },
    ]);
  });

  it('reads an EMPTY argument bag as no arguments, not as empty arguments', () => {
    // Measured on cursor-agent 2026.08.04-aaa8809: its read/search/edit calls
    // send `rawInput: {}` on the initial `tool_call` and never send arguments on
    // any later update. Carrying the `{}` through made the transcript render the
    // arguments as `{}` — the reported defect. Null is the honest reading, and
    // it is what lets the renderer omit the body entirely.
    const h = harness();
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 't-empty',
          title: 'Read File',
          rawInput: {},
        }),
      ),
    ).toEqual([
      { type: 'tool_call', id: 't-empty', name: 'Read File', input: null },
    ]);
  });

  it("carries the agent's OWN classification of the call", () => {
    // Without it the transcript has to recognise this agent's tool NAMES to say
    // what a turn did — and cursor's are "Read File"/"Edit File"/"grep" with no
    // arguments at all, so its group summary read "Used 3 tools" and named none
    // of the work. ACP classifies every call; this is that field reaching the row.
    const h = harness();
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 't-kind',
          title: 'Edit File',
          kind: 'edit',
          rawInput: {},
        }),
      ),
    ).toEqual([
      {
        type: 'tool_call',
        id: 't-kind',
        name: 'Edit File',
        input: null,
        kind: 'edit',
      },
    ]);
  });

  it('omits the kind entirely when the agent classified nothing', () => {
    // `other` would claim a classification nobody made, and the renderer reads
    // "no kind" as "fall through to the name buckets".
    const h = harness();
    const [event] = h.feed(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't-nokind',
        title: 'Mystery',
      }),
    ) as { kind?: unknown }[];
    expect(event).not.toHaveProperty('kind');
  });

  it('normalizes the diff an edit reports into the shape the row renders', () => {
    // Probed on cursor-agent 2026.08.11-e8db854: an `edit` call sends
    // `rawInput: {}`, never fills it, sends no `locations` — and reports the whole
    // change, path included, as a `diff` content block on the completing update.
    // Passed through raw it rendered as the block ARRAY in JSON, escaped newlines
    // and all; `{diffs}` is what the transcript draws as a diff.
    const h = harness();
    h.feed(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't-diff',
        title: 'Edit File',
        kind: 'edit',
        rawInput: {},
      }),
    );
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 't-diff',
          status: 'completed',
          content: [
            {
              type: 'diff',
              path: '/w/notes.txt',
              oldText: 'alpha\nbeta\n',
              newText: 'alpha\nBETA edited\n',
            },
          ],
        }),
      ),
    ).toEqual([
      {
        type: 'tool_result',
        id: 't-diff',
        name: 'Edit File',
        result: {
          diffs: [
            {
              path: '/w/notes.txt',
              oldText: 'alpha\nbeta\n',
              newText: 'alpha\nBETA edited\n',
            },
          ],
        },
        isError: false,
      },
    ]);
  });

  it("prefers the agent's rawOutput over a diff, and passes other content through", () => {
    // Two guards in one: an agent that reports BOTH keeps its own output (the
    // richer answer), and content that is not a diff must reach the row exactly
    // as it did before — the normalization is additive, not a filter.
    const h = harness();
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 't-both',
          status: 'completed',
          rawOutput: { exitCode: 0 },
          content: [{ type: 'diff', path: '/w/a', newText: 'x' }],
        }),
      ),
    ).toMatchObject([{ result: { exitCode: 0 } }]);
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 't-text',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'hi' } }],
        }),
      ),
    ).toMatchObject([
      { result: [{ type: 'content', content: { type: 'text', text: 'hi' } }] },
    ]);
  });

  it('closes the pair only on a settled tool call', () => {
    const h = harness();
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 't-3',
          status: 'in_progress',
        }),
      ),
    ).toEqual([]);
    expect(
      h.feed(
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 't-3',
          status: 'failed',
        }),
      ),
    ).toEqual([
      {
        type: 'tool_result',
        id: 't-3',
        name: null,
        result: null,
        isError: true,
      },
    ]);
  });

  it('harvests the available commands for the composer autocomplete', () => {
    const h = harness();
    expect(
      h.feed(
        update({
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'review', description: 'Review the diff' },
            { name: 'shell', description: null },
            { name: '', description: 'skipped' },
            { description: 'no name' },
          ],
        }),
      ),
    ).toEqual([
      {
        type: 'slash_commands',
        // The DESCRIPTION rides along, because for an ACP agent with no
        // on-disk convention geniro can scan this frame is the only place it
        // exists — reading just the name left every row in the composer's `/`
        // popup a bare word. An entry that reports none stays null.
        commands: [
          { name: 'review', description: 'Review the diff' },
          { name: 'shell', description: null },
        ],
      },
    ]);
  });

  it('ignores updates the transcript does not model', () => {
    const h = harness();
    expect(h.feed(chunk('user_message_chunk', 'our own prompt'))).toEqual([]);
    expect(h.feed(update({ sessionUpdate: 'plan', entries: [] }))).toEqual([]);
    expect(h.feed(update({ sessionUpdate: 'current_mode_update' }))).toEqual(
      [],
    );
  });

  it('degrades a malformed notification to no events', () => {
    const h = harness();
    expect(h.feed({ method: 'session/update', params: null })).toEqual([]);
    expect(
      h.feed({ method: 'session/update', params: { update: 'nope' } }),
    ).toEqual([]);
  });
});

describe('AcpTurnDriver turn completion', () => {
  /** Drive the handshake so the turn is ready for its prompt reply (id 3). */
  function primed(overrides: Partial<AcpDriverOptions> = {}): Harness {
    const h = harness(overrides);
    h.feed(initializeReply(1));
    h.feed({ id: 2, result: { sessionId: 's' } });
    return h;
  }

  it('completes with the stop reason and the accumulated answer text', () => {
    const h = primed();
    h.feed(chunk('agent_message_chunk', 'part one '));
    h.feed(chunk('agent_message_chunk', 'part two'));
    // The joined `text` row is the regression pin: a durable event per chunk
    // put a real cursor reply into the transcript as 68 one-word rows.
    expect(h.feed({ id: 3, result: { stopReason: 'end_turn' } })).toEqual([
      { type: 'text', text: 'part one part two' },
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
          // ACP has no turn-timing channel at all, so the driver reports none
          // rather than passing off its own wall clock as the agent's figure.
          durationMs: null,
          apiMs: null,
        },
        stopReason: 'end_turn',
        finalText: 'part one part two',
      },
    ]);
  });

  it('reports a cancelled turn as cancelled, never as a completion', () => {
    const h = primed();
    h.feed(chunk('agent_message_chunk', 'half an answer'));
    expect(h.feed({ id: 3, result: { stopReason: 'cancelled' } })).toEqual([
      { type: 'text', text: 'half an answer' },
      { type: 'turn_cancelled' },
    ]);
  });

  it('keeps a non-end_turn stop reason as a completion', () => {
    const h = primed();
    const [event] = h.feed({ id: 3, result: { stopReason: 'max_tokens' } });
    expect(event).toMatchObject({
      type: 'turn_complete',
      stopReason: 'max_tokens',
    });
  });

  it('combines the prompt reply tokens with the streamed context usage', () => {
    const h = primed();
    h.feed(
      update({
        sessionUpdate: 'usage_update',
        used: 4200,
        size: 200_000,
        cost: { amount: 0.42, currency: 'USD' },
      }),
    );
    const [event] = h.feed({
      id: 3,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      },
    });
    expect(event).toMatchObject({
      type: 'turn_complete',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        thinkingTokens: null,
        contextTokens: 4200,
        contextWindowTokens: null,
        contextModel: null,
        costUsd: 0.42,
      },
    });
  });

  it('falls back to the input count when no usage_update ever arrived', () => {
    const h = primed();
    const [event] = h.feed({
      id: 3,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 77, outputTokens: 1 },
      },
    });
    expect(event).toMatchObject({ usage: { contextTokens: 77 } });
  });

  it('refuses to report a non-USD cost in the costUsd field', () => {
    const h = primed();
    h.feed(
      update({
        sessionUpdate: 'usage_update',
        used: 10,
        size: 100,
        cost: { amount: 5, currency: 'EUR' },
      }),
    );
    const [event] = h.feed({ id: 3, result: { stopReason: 'end_turn' } });
    expect(event).toMatchObject({
      usage: { costUsd: null, contextTokens: 10, contextWindowTokens: null },
    });
  });

  it('reports no final text when the agent streamed none', () => {
    const h = primed();
    const [event] = h.feed({ id: 3, result: { stopReason: 'end_turn' } });
    expect(event).toMatchObject({ finalText: null });
  });
});

describe('AcpTurnDriver off-protocol context reading', () => {
  const READING = {
    usedTokens: 101_100,
    windowTokens: 200_000,
    model: 'cursor-grok-4.6',
  };
  const PROGRESS = {
    type: 'context_progress',
    contextTokens: 101_100,
    contextWindowTokens: 200_000,
    contextModel: 'cursor-grok-4.6',
  };

  /** Drive the handshake, returning the events the session reply produced. */
  function opened(overrides: Partial<AcpDriverOptions>): {
    h: Harness;
    onSession: AgentEvent[];
  } {
    const h = harness(overrides);
    h.feed(initializeReply(1));
    return { h, onSession: h.feed({ id: 2, result: { sessionId: 's' } }) };
  }

  it('reports the window BEFORE the prompt, so a resumed chat is scaled at once', () => {
    // ACP carries no context accounting, so an agent whose figures live off
    // protocol had none until its turn ended: the reported cursor chat showed a
    // full breakdown in the panel behind a ring that had never been given a
    // reading. Taken at the session reply — the prompt has not gone out yet.
    const { onSession } = opened({ readContext: () => READING });
    expect(onSession).toContainEqual(PROGRESS);
  });

  it('takes a fresh reading AHEAD of the turn_complete that settles the run', () => {
    // Order is the assertion: the live plane a reading rides is cleared when the
    // run settles, so one emitted after `turn_complete` would be published into
    // a state the client has already been told to drop.
    const { h } = opened({ readContext: () => READING });
    const events = h.feed({ id: 3, result: { stopReason: 'end_turn' } });
    const reading = events.findIndex((e) => e.type === 'context_progress');
    const complete = events.findIndex((e) => e.type === 'turn_complete');
    expect(reading).toBeGreaterThanOrEqual(0);
    expect(reading).toBeLessThan(complete);
  });

  it('says nothing when the source has no used figure yet', () => {
    // A session the CLI has not written to — a fresh conversation's first turn.
    // An empty window is not a reading of zero, and a ring drawn at 0% would be
    // a claim rather than a silence.
    const { h, onSession } = opened({
      readContext: () => ({
        usedTokens: null,
        windowTokens: 200_000,
        model: null,
      }),
    });
    expect(onSession.some((e) => e.type === 'context_progress')).toBe(false);
    expect(
      h
        .feed({ id: 3, result: { stopReason: 'end_turn' } })
        .some((e) => e.type === 'context_progress'),
    ).toBe(false);
  });

  it('survives a source that throws — a meter is not worth a failed turn', () => {
    const warn = vi.fn();
    const { h, onSession } = opened({
      readContext: () => {
        throw new Error('store is locked');
      },
      logger: { warn },
    });
    expect(onSession.some((e) => e.type === 'context_progress')).toBe(false);
    // …and the turn still finishes normally rather than dying on the readout.
    expect(
      h.feed({ id: 3, result: { stopReason: 'end_turn' } }),
    ).toContainEqual(
      expect.objectContaining({
        type: 'turn_complete',
        stopReason: 'end_turn',
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('store is locked'),
    );
  });
});

describe('AcpTurnDriver permissions', () => {
  function permissionRequest(
    id: number | string,
    overrides: Record<string, unknown> = {},
  ): unknown {
    return {
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 's',
        toolCall: {
          toolCallId: 't-1',
          name: 'write_file',
          kind: 'edit',
          rawInput: { path: 'a.ts' },
          ...overrides,
        },
        options: [
          { optionId: 'o-allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'o-always', name: 'Always', kind: 'allow_always' },
          { optionId: 'o-reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    };
  }

  it('answers without the user when the policy decides, emitting nothing', () => {
    const h = harness({ autoDecide: () => 'allow' });
    expect(h.feed(permissionRequest(5))).toEqual([]);
    const reply = h.sent.find((frame) => frame.id === 5);
    expect(reply?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'o-allow' },
    });
  });

  it('passes the tool call to the policy so it can classify the request', () => {
    const autoDecide = vi.fn(() => null);
    const h = harness({ autoDecide });
    h.feed(permissionRequest(5));
    expect(autoDecide).toHaveBeenCalledWith({
      toolCallId: 't-1',
      name: 'write_file',
      kind: 'edit',
      status: null,
      rawInput: { path: 'a.ts' },
      rawOutput: null,
    });
  });

  it('parks the request as an approval card when the policy defers', () => {
    const h = harness();
    expect(h.feed(permissionRequest(5))).toEqual([
      {
        type: 'approval_request',
        id: 'n:5',
        toolName: 'write_file',
        input: { path: 'a.ts' },
      },
    ]);
    // Nothing was answered — the agent stays parked until a verdict arrives.
    expect(h.sent.some((frame) => frame.id === 5)).toBe(false);
  });

  it('names a parked card from the tool call it belongs to when the request omits the name', () => {
    const h = harness();
    // ACP's permission request carries a ToolCallUpdate, where every field
    // except toolCallId is optional — the agent already named this call once,
    // on the tool_call update the driver recorded.
    h.feed(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't-1',
        name: 'write_file',
        kind: 'edit',
      }),
    );
    expect(
      h.feed({
        id: 5,
        method: 'session/request_permission',
        params: {
          sessionId: 's',
          toolCall: { toolCallId: 't-1' },
          options: [{ optionId: 'o-allow', name: 'Allow', kind: 'allow_once' }],
        },
      }),
    ).toEqual([
      {
        type: 'approval_request',
        id: 'n:5',
        toolName: 'write_file',
        input: null,
      },
    ]);
  });

  it('answers a parked request with the id type the agent used', () => {
    const numeric = harness();
    numeric.feed(permissionRequest(5));
    const allow = numeric.driver.buildApprovalResponse('n:5', true);
    expect(JSON.parse(allow ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 5,
      result: { outcome: { outcome: 'selected', optionId: 'o-allow' } },
    });

    const textual = harness();
    textual.feed(permissionRequest('req-a'));
    const deny = textual.driver.buildApprovalResponse('s:req-a', false);
    expect(JSON.parse(deny ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 'req-a',
      result: { outcome: { outcome: 'selected', optionId: 'o-reject' } },
    });
  });

  it('never selects an *_always option', () => {
    // An always-choice would outlive the turn the user was asked about.
    const h = harness();
    h.feed({
      id: 5,
      method: 'session/request_permission',
      params: {
        toolCall: { toolCallId: 't', name: 'x' },
        options: [
          { optionId: 'o-always', name: 'Always', kind: 'allow_always' },
        ],
      },
    });
    expect(
      JSON.parse(h.driver.buildApprovalResponse('n:5', true) ?? ''),
    ).toEqual({
      jsonrpc: '2.0',
      id: 5,
      result: { outcome: { outcome: 'cancelled' } },
    });
  });

  it('refuses to answer an unknown or already-answered request', () => {
    const h = harness();
    h.feed(permissionRequest(5));
    expect(h.driver.buildApprovalResponse('n:5', true)).toBeDefined();
    // Answering twice must not write a second reply for the same id.
    expect(h.driver.buildApprovalResponse('n:5', true)).toBeUndefined();
    expect(h.driver.buildApprovalResponse('n:404', true)).toBeUndefined();
    expect(h.driver.buildApprovalResponse('untagged', true)).toBeUndefined();
  });
});

describe('selectPermissionOption', () => {
  it('picks the once-scoped option in the requested direction', () => {
    const options = [
      { optionId: 'a', name: 'Allow', kind: 'allow_once' as const },
      { optionId: 'r', name: 'Reject', kind: 'reject_once' as const },
    ];
    expect(selectPermissionOption(options, true)).toBe('a');
    expect(selectPermissionOption(options, false)).toBe('r');
  });

  it('returns null rather than guessing when nothing matches', () => {
    expect(selectPermissionOption([], true)).toBeNull();
    expect(
      selectPermissionOption(
        [{ optionId: 'x', name: 'Always', kind: 'reject_always' }],
        false,
      ),
    ).toBeNull();
  });
});

describe('AcpTurnDriver unsupported requests', () => {
  it('declines an unimplemented client method in-protocol, once, with a notice', () => {
    const h = harness();
    // A blocking request left unanswered parks the agent for the whole turn.
    const events = h.feed({
      id: 9,
      method: 'fs/read_text_file',
      params: { path: '/etc/hosts' },
    });
    expect(h.sent.find((frame) => frame.id === 9)?.error).toEqual({
      code: -32601,
      message: 'fs/read_text_file is not implemented by this client',
    });
    expect(events).toEqual([
      {
        type: 'notice',
        message:
          "agent asked for 'fs/read_text_file', which this client does not implement; it was declined",
      },
    ]);

    // Still answered, but the transcript is not spammed with one notice each.
    expect(h.feed({ id: 10, method: 'terminal/create', params: {} })).toEqual(
      [],
    );
    expect(h.sent.find((frame) => frame.id === 10)?.error).toBeDefined();
  });

  it('ignores a vendor notification instead of replying to it', () => {
    const h = harness();
    const before = h.sent.length;
    expect(
      h.feed({ method: 'cursor/update_todos', params: { todos: [] } }),
    ).toEqual([]);
    expect(h.sent.length).toBe(before);
  });

  it('warns rather than throwing when a reply cannot be written', () => {
    const warn = vi.fn();
    const h = harness({ logger: { warn } }, false);
    h.feed({ id: 9, method: 'fs/read_text_file', params: {} });
    expect(warn).toHaveBeenCalledWith(
      'acp: dropped the error reply to fs/read_text_file — stdin is closed',
    );
  });
});

describe('AcpTurnDriver vendor question channel', () => {
  const ASK = 'vendor/ask_question';
  /** A stand-in protocol: the driver must know NO agent's question shape. */
  const question = {
    method: ASK,
    toolName: ASK,
    accepts: (params: unknown) =>
      Array.isArray((params as { questions?: unknown[] })?.questions),
    encodeReply: (_params: unknown, allow: boolean, updatedInput: unknown) => ({
      outcome: allow ? { outcome: 'answered', updatedInput } : 'declined',
    }),
  };
  const askRequest = {
    id: 9,
    method: ASK,
    params: { questions: [{ id: 'q1', prompt: 'Which?' }] },
  };

  it('parks the question as a card rather than declining it', () => {
    // The regression: a BLOCKING vendor request answered with -32601 stalls
    // the turn on a question the user was never shown.
    const h = harness({ question });
    const events = h.feed(askRequest);

    expect(events).toEqual([
      {
        type: 'approval_request',
        id: 'n:9',
        toolName: ASK,
        input: askRequest.params,
        requiresUserInteraction: true,
      },
    ]);
    // Nothing was sent — the agent stays parked until a verdict arrives.
    expect(h.sent.some((frame) => frame.id === 9)).toBe(false);
  });

  it('answers it with the adapter’s encoder, not a permission outcome', () => {
    const h = harness({ question });
    h.feed(askRequest);

    const reply = h.driver.buildApprovalResponse('n:9', true, { answer: 'a' });
    expect(JSON.parse(reply ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 9,
      result: {
        outcome: { outcome: 'answered', updatedInput: { answer: 'a' } },
      },
    });
  });

  it('is never auto-decided, however permissive the turn’s posture', () => {
    // `autoDecide` resolves a PERMISSION posture. A question has no safe
    // machine answer, so an `auto` turn must still surface the card.
    const h = harness({ question, autoDecide: () => 'allow' as const });
    expect(h.feed(askRequest)).toHaveLength(1);
    expect(h.sent.some((frame) => frame.id === 9)).toBe(false);
  });

  it('declines a payload it cannot read as a question, as before', () => {
    // The shape is documented rather than observed, so drift must cost only
    // today's behaviour — never a card the user cannot answer.
    const warn = vi.fn();
    const h = harness({ question, logger: { warn } });
    const events = h.feed({ id: 9, method: ASK, params: { nope: true } });

    expect(h.sent.find((frame) => frame.id === 9)?.error).toEqual({
      code: -32601,
      message: `${ASK} is not implemented by this client`,
    });
    expect(events).toEqual([
      {
        type: 'notice',
        message: `agent asked for '${ASK}', which this client does not implement; it was declined`,
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      `acp: ${ASK} arrived in an unrecognized shape — declined rather than shown as a question`,
    );
  });

  it('declines it outright for a driver given no question protocol', () => {
    const h = harness();
    h.feed(askRequest);
    expect(h.sent.find((frame) => frame.id === 9)?.error).toBeDefined();
  });
});

describe('AcpTurnDriver refusals the agent absorbs', () => {
  const HARMLESS = 'vendor/update_todos';
  const options = { declinedWithoutNotice: [HARMLESS] };

  it('declines them in-protocol but spends no notice', () => {
    const h = harness(options);
    const events = h.feed({ id: 7, method: HARMLESS, params: { todos: [] } });

    // Still answered — a request left hanging parks the agent either way.
    expect(h.sent.find((frame) => frame.id === 7)?.error).toEqual({
      code: -32601,
      message: `${HARMLESS} is not implemented by this client`,
    });
    expect(events).toEqual([]);
  });

  it('leaves the turn’s ONE notice for a refusal that actually costs something', () => {
    // The regression this pins, and the reason the list exists at all: the
    // notice is a per-turn budget of one. Measured on cursor-agent
    // 2026.08.04, an ordinary planning turn sends `cursor/update_todos` — a
    // refusal its own agent discards — which under the old behaviour burnt
    // the slot, leaving a consequential refusal later in the same turn
    // unmentioned.
    const h = harness(options);
    expect(h.feed({ id: 7, method: HARMLESS, params: {} })).toEqual([]);

    const events = h.feed({ id: 8, method: 'fs/read_text_file', params: {} });
    expect(events).toEqual([
      {
        type: 'notice',
        message:
          "agent asked for 'fs/read_text_file', which this client does not implement; it was declined",
      },
    ]);
  });

  it('still narrates a method that is NOT on the list', () => {
    const h = harness(options);
    const events = h.feed({
      id: 7,
      method: 'vendor/something_else',
      params: {},
    });
    expect(events).toHaveLength(1);
  });

  it('records the silent refusal on the debug channel rather than nowhere', () => {
    const debug = vi.fn();
    const h = harness({ ...options, logger: { warn: vi.fn(), debug } });
    h.feed({ id: 7, method: HARMLESS, params: {} });

    expect(debug).toHaveBeenCalledWith(
      `acp: declined ${HARMLESS}; the agent handles that refusal itself`,
    );
  });
});

describe('AcpTurnDriver image attachments', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  /** A real file on disk — the driver reads bytes, not a fixture string. */
  function imageInput(): AgentTurnInput {
    const path = join(tempDir('acp-driver-images-'), 'a.png');
    writeFileSync(path, PNG);
    return {
      ...BASE_INPUT,
      images: [{ path, mediaType: 'image/png' }],
    };
  }

  /**
   * Drive the handshake to the point where `session/prompt` has been sent,
   * keeping the events the session reply produced — that is the channel the
   * prompt-time notice rides, not the `onStdinReady` one.
   */
  function promptedWith(image: boolean): {
    h: Harness;
    events: AgentEvent[];
  } {
    const h = harness({ input: imageInput() });
    h.feed(initializeReply(1, { image }));
    return { h, events: h.feed({ id: 2, result: { sessionId: 'sess-1' } }) };
  }

  it('sends the attached image to an agent that accepts image prompts', () => {
    const { h } = promptedWith(true);

    expect(h.sentMethod('session/prompt')?.params).toEqual({
      sessionId: 'sess-1',
      // Images first, then the text — the order the claude path sends.
      prompt: [
        { type: 'image', mimeType: 'image/png', data: PNG.toString('base64') },
        { type: 'text', text: 'do the thing' },
      ],
    });
  });

  it('withholds the image from an agent that never advertised the capability, and says so', () => {
    // Sending anyway earns an error reply that fails the whole turn over an
    // attachment; dropping it quietly leaves the user watching the agent
    // answer about a screenshot it never got. Neither is acceptable, so the
    // turn runs text-only WITH a notice.
    const { h, events } = promptedWith(false);

    expect(h.sentMethod('session/prompt')?.params).toEqual({
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: 'do the thing' }],
    });
    expect(events).toContainEqual({
      type: 'notice',
      message:
        'agent does not accept image prompts — 1 attached image was not sent with this turn',
    });
  });

  it('says nothing about images on a turn that has none', () => {
    // The notice is about a real loss; a text-only turn must not carry it.
    const h = harness();
    h.feed(initializeReply(1, { image: false }));
    const events = h.feed({ id: 2, result: { sessionId: 'sess-1' } });

    expect(
      [...events, ...h.emitted].filter(
        (event) => event.type === 'notice' && event.message.includes('image'),
      ),
    ).toEqual([]);
  });

  it('fails the turn on an unreadable attachment instead of prompting without it', () => {
    // Constructed inside AgentAdapter.start's synchronous try, so this is the
    // seam where a broken attachment stops the turn.
    expect(
      () =>
        new AcpTurnDriver({
          input: {
            ...BASE_INPUT,
            images: [{ path: '/nope/missing.png', mediaType: 'image/png' }],
          },
          clientName: 'geniro',
          clientVersion: '1.2.3',
          autoDecide: () => null,
          composeSystemPrompt: () => '',
        }),
    ).toThrow();
  });
});

describe('AcpTurnDriver task list', () => {
  const TODOS = 'vendor/update_todos';
  /** A reader in the shape an adapter supplies one — the params are its facts. */
  const todos = {
    method: TODOS,
    read: (params: unknown) => {
      const record = params as { rows?: unknown[]; whole?: boolean } | null;
      if (!Array.isArray(record?.rows)) {
        return null;
      }
      return {
        mode: (record.whole === true ? 'snapshot' : 'patch') as
          'snapshot' | 'patch',
        tasks: record.rows.map((row) => row as never),
        toolCallId: 'call-1',
      };
    },
  };

  it('ANSWERS the announcement and emits the list', () => {
    // The bug this fixes was a silent one: the announcement is a blocking
    // request whose agent absorbs a refusal, so declining it cost the turn
    // nothing and threw the list away with no symptom anywhere.
    const h = harness({ todos });
    const events = h.feed({
      id: 4,
      method: TODOS,
      params: { whole: true, rows: [{ id: '1' }] },
    });

    expect(h.sent.find((frame) => frame.id === 4)).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: {},
    });
    expect(events).toEqual([
      {
        type: 'task_list',
        mode: 'snapshot',
        tasks: [{ id: '1' }],
        toolCallId: 'call-1',
      },
    ]);
  });

  it('carries the mode the READER decided, never one inferred here', () => {
    const h = harness({ todos });
    const events = h.feed({ id: 5, method: TODOS, params: { rows: [] } });
    expect(events[0]?.type === 'task_list' && events[0].mode).toBe('patch');
  });

  it('falls back to the decline when the payload does not read as a list', () => {
    const warn = vi.fn();
    const h = harness({ todos, logger: { warn } });
    const events = h.feed({ id: 6, method: TODOS, params: { rows: 'nope' } });

    expect(h.sent.find((frame) => frame.id === 6)?.error).toEqual({
      code: -32601,
      message: `${TODOS} is not implemented by this client`,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('notice');
    expect(warn).toHaveBeenCalledWith(
      `acp: ${TODOS} arrived in an unrecognized shape — declined rather than recorded as a task list`,
    );
  });

  it('declines it outright for a driver given no todo protocol', () => {
    const h = harness();
    expect(
      h.feed({ id: 7, method: TODOS, params: { rows: [{ id: '1' }] } }).length,
    ).toBe(1);
    expect(h.sent.find((frame) => frame.id === 7)?.error).toBeDefined();
  });
});

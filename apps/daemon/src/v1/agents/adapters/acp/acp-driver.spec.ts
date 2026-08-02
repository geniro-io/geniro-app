import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

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
    // Mirrors AgentAdapter.composeSystemPrompt — the driver only decides
    // whether the call tools were granted, never what the text is.
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

  it('emits adapter-supplied startup notices before the handshake', () => {
    const h = harness({ startupNotices: ['model X was not applied'] });
    expect(h.emitted).toEqual([
      { type: 'notice', message: 'model X was not applied' },
    ]);
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
      { type: 'text', text: 'a new answer' },
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

  it('never claims a resumed turn’s agent lacks the mode — session/load reports none', () => {
    const h = harness({
      input: { ...BASE_INPUT, resumeSessionId: 'prior-7' },
      preferredModeId: 'plan',
    });
    h.feed(initializeReply(1, { loadSession: true }));
    // A `session/load` reply carries no `modes` block at all. Reading that
    // absence as "not offered" would put a false statement about the agent
    // into the transcript of every resumed turn.
    const events = h.feed({ id: 2, result: {} });

    expect(
      events.filter(
        (e) => e.type === 'notice' && e.message.includes('does not offer'),
      ),
    ).toEqual([]);
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
    ).toEqual([{ type: 'slash_commands', commands: ['review'] }]);
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
      { type: 'notice', message: "agent declined session mode 'plan': no" },
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
  it('maps message and thought chunks', () => {
    const h = harness();
    expect(h.feed(chunk('agent_message_chunk', 'hello'))).toEqual([
      { type: 'text', text: 'hello' },
    ]);
    expect(h.feed(chunk('agent_thought_chunk', 'hmm'))).toEqual([
      { type: 'reasoning', text: 'hmm' },
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
            { name: 'review', description: 'r' },
            { name: '', description: 'skipped' },
            { description: 'no name' },
          ],
        }),
      ),
    ).toEqual([{ type: 'slash_commands', commands: ['review'] }]);
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
    expect(h.feed({ id: 3, result: { stopReason: 'end_turn' } })).toEqual([
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
        finalText: 'part one part two',
      },
    ]);
  });

  it('reports a cancelled turn as cancelled, never as a completion', () => {
    const h = primed();
    h.feed(chunk('agent_message_chunk', 'half an answer'));
    expect(h.feed({ id: 3, result: { stopReason: 'cancelled' } })).toEqual([
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
        contextTokens: 4200,
        contextWindowTokens: null,
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

describe('AcpTurnDriver image attachments', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  /** A real file on disk — the driver reads bytes, not a fixture string. */
  function imageInput(): AgentTurnInput {
    const path = join(
      mkdtempSync(join(tmpdir(), 'acp-driver-images-')),
      'a.png',
    );
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

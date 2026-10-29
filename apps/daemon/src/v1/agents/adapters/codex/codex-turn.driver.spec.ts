import { describe, expect, it } from 'vitest';

import type { AgentEvent, AgentTurnInput, TurnIo } from '../adapter.types';
import { CodexSession } from './codex-session';
import type { CodexTurnOptions } from './codex-turn.driver';
import { codexTurnPolicy } from './utils/codex-policy.utils';

const THREAD = 'thread-model-test';
const TURN = 'turn-model-test';

interface SentFrame {
  id?: string;
  method: string;
  params: unknown;
}

/** A session over a captured stdin, through its handshake. */
function openConversation(input: AgentTurnInput) {
  const written: string[] = [];
  const io: TurnIo = {
    write: (payload) => {
      written.push(payload);
      return true;
    },
    emit: () => undefined,
  };
  const optionsFor = (turnInput: AgentTurnInput): CodexTurnOptions => ({
    input: turnInput,
    developerInstructions: '',
    config: null,
    policy: codexTurnPolicy(turnInput.approvalMode),
    autoCompactTokens: null,
    mcpDisabled: turnInput.mcpDisabled ?? [],
  });
  const session = new CodexSession(
    {
      clientVersion: 'test',
      turnOptions: optionsFor,
    },
    input,
  );
  const frames = () => written.map((line) => JSON.parse(line) as SentFrame);
  const request = (method: string) =>
    frames().findLast((frame) => frame.method === method);
  session.onStdinReady(io);
  return { session, io, frames, request };
}

function conversation(requestedModel?: string, reportedModel?: string) {
  const input: AgentTurnInput = {
    prompt: 'Hello',
    cwd: '/repo',
    model: requestedModel,
  };
  const { session, io, request: sent } = openConversation(input);
  const request = (method: string) => sent(method)!;
  const events = session.onMessage({
    id: request('thread/start').id,
    result: { thread: { id: THREAD }, model: reportedModel },
  });
  events.push(
    ...session.onMessage({
      id: request('turn/start').id,
      result: { turn: { id: TURN } },
    }),
  );
  return { session, events, input, io, request };
}

function modelUsage(session: CodexSession, model?: string, threadId = THREAD) {
  const breakdown = { totalTokens: 10, inputTokens: 8, outputTokens: 2 };
  return session.onMessage({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId: TURN,
      tokenUsage: {
        model,
        total: breakdown,
        last: breakdown,
        modelContextWindow: 200_000,
      },
    },
  });
}

function notices(events: AgentEvent[]) {
  return events.filter((event) => event.type === 'notice');
}

describe('the model codex reports for a turn', () => {
  it('posts one notice across the thread and usage reports, naming both ids', () => {
    const { session, events } = conversation('gpt-5.5', 'gpt-5.4');
    events.push(...modelUsage(session, 'gpt-5.4'));
    expect(notices(events)).toHaveLength(1);
    expect(notices(events)[0]?.message).toContain('gpt-5.5');
    expect(notices(events)[0]?.message).toContain('gpt-5.4');
  });

  it('uses a fresh usage report when the served model differs from the thread', () => {
    const { session, events } = conversation('gpt-5.5', 'gpt-5.5');
    events.push(...modelUsage(session, 'gpt-5.4'));
    events.push(...modelUsage(session, 'gpt-5.4'));
    expect(notices(events)).toHaveLength(1);
    const terminal = session.onMessage({
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
    });
    expect(terminal).toContainEqual(
      expect.objectContaining({
        type: 'turn_complete',
        usage: expect.objectContaining({ contextModel: 'gpt-5.4' }),
      }),
    );
  });

  it('shares its notice allowance with explicit reroutes', () => {
    const { session, events } = conversation('gpt-5.5', 'gpt-5.5');
    const reroute = {
      method: 'model/rerouted',
      params: {
        threadId: THREAD,
        turnId: TURN,
        fromModel: 'gpt-5.5',
        toModel: 'gpt-5.4',
        reason: 'capacity',
      },
    };
    events.push(...session.onMessage(reroute));
    events.push(...modelUsage(session, 'gpt-5.4'));
    events.push(...session.onMessage(reroute));
    expect(notices(events)).toHaveLength(1);
    expect(notices(events)[0]?.message).toContain('capacity');
  });

  it('does not repeat a mismatch when a reroute follows the usage report', () => {
    const { session, events } = conversation('gpt-5.5', 'gpt-5.5');
    events.push(...modelUsage(session, 'gpt-5.4'));
    events.push(
      ...session.onMessage({
        method: 'model/rerouted',
        params: { threadId: THREAD, fromModel: 'gpt-5.5', toModel: 'gpt-5.4' },
      }),
    );
    expect(notices(events)).toHaveLength(1);
  });

  it.each(['default', 'codex-mini-latest', undefined])(
    'does not guess how alias %s resolves',
    (requested) => {
      const { session, events } = conversation(requested, 'gpt-5.5');
      events.push(...modelUsage(session, 'gpt-5.5'));
      expect(notices(events)).toEqual([]);
    },
  );

  it('says nothing when this turn reports no model', () => {
    const { session, events } = conversation('gpt-5.5');
    events.push(...modelUsage(session));
    expect(notices(events)).toEqual([]);
  });

  it('does not compare a sub-agent report to the parent request', () => {
    const { session, events } = conversation('gpt-5.5', 'gpt-5.5');
    events.push(...modelUsage(session, 'gpt-5.4', 'other-thread'));
    expect(notices(events)).toEqual([]);
  });

  it('gives the next turn on a kept process its own notice allowance', () => {
    const { session, events, input, io, request } = conversation(
      'gpt-5.5',
      'gpt-5.5',
    );
    events.push(...modelUsage(session, 'gpt-5.4'));
    session.onMessage({
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
    });
    session.openTurn(io, input);
    events.push(
      ...session.onMessage({
        id: request('turn/start').id,
        result: { turn: { id: 'next-turn', model: 'gpt-5.4' } },
      }),
    );
    expect(notices(events)).toHaveLength(2);
  });
});

describe('subagent tracking loss', () => {
  it('keeps an unknown child ending distinct from failure, then accepts a reported completion', () => {
    const { session } = conversation();
    session.subagents.set('child', 'spawn-call');
    session.openSubagent('spawn-call');
    expect(
      session.onMessage({
        method: 'turn/completed',
        params: { threadId: 'child', turn: { id: 'child-turn' } },
      }),
    ).toContainEqual(
      expect.objectContaining({
        type: 'subagent_info',
        id: 'spawn-call',
        backgroundOutcome: 'untracked',
      }),
    );
    expect(
      session.onMessage({
        method: 'turn/completed',
        params: {
          threadId: 'child',
          turn: { id: 'child-turn', status: 'completed' },
        },
      }),
    ).toContainEqual(
      expect.objectContaining({
        type: 'subagent_info',
        id: 'spawn-call',
        backgroundOutcome: 'completed',
      }),
    );
  });
});

describe("the user's own codex PermissionRequest hooks", () => {
  const PERMISSION_HOOK = '/home/.codex/hooks.json:permission_request:0:0';
  const HOOKS_LISTED = {
    data: [
      {
        cwd: '/repo',
        errors: [],
        warnings: [],
        hooks: [
          {
            key: PERMISSION_HOOK,
            eventName: 'permissionRequest',
            enabled: true,
            isManaged: false,
          },
          {
            key: '/home/.codex/hooks.json:permission_request:1:0',
            eventName: 'permissionRequest',
            enabled: false,
            isManaged: false,
          },
          {
            key: '/home/.codex/hooks.json:pre_tool_use:0:0',
            eventName: 'preToolUse',
            enabled: true,
            isManaged: false,
          },
        ],
      },
    ],
  };
  const PERMISSION_HOOK_OFF = {
    'hooks.state': { [PERMISSION_HOOK]: { enabled: false } },
  };

  function conversationIn(overrides: Partial<AgentTurnInput> = {}) {
    const { session, frames, request } = openConversation({
      prompt: 'search the shared memory',
      cwd: '/repo',
      approvalMode: 'ask',
      ...overrides,
    });
    return { session, frames, sent: request };
  }

  const configOf = (frame: { params: unknown } | undefined) =>
    (frame?.params as { config?: unknown } | undefined)?.config;

  it.each(['ask', 'acceptEdits', 'plan', 'auto'] as const)(
    'are switched off on a thread opened in %s, so no approval waits on a blocking hook first',
    (approvalMode) => {
      const { session, frames, sent } = conversationIn({ approvalMode });
      expect(frames().map((frame) => frame.method)).toEqual([
        'initialize',
        'initialized',
        'hooks/list',
      ]);
      const list = sent('hooks/list')!;
      expect(list.params).toEqual({ cwds: ['/repo'] });
      session.onMessage({ id: list.id, result: HOOKS_LISTED });
      expect(configOf(sent('thread/start'))).toEqual(PERMISSION_HOOK_OFF);
    },
  );

  it('are switched off on a reopened thread too', () => {
    const { session, sent } = conversationIn({ resumeSessionId: 'thread-1' });
    expect(sent('thread/resume')).toBeUndefined();
    session.onMessage({ id: sent('hooks/list')!.id, result: HOOKS_LISTED });
    expect(configOf(sent('thread/resume'))).toEqual(PERMISSION_HOOK_OFF);
  });

  it('are listed after the MCP servers are read, and both overrides ride the thread', () => {
    const { session, frames, sent } = conversationIn({
      mcpDisabled: ['linear'],
    });
    session.onMessage({
      id: sent('config/read')!.id,
      result: {
        config: {
          mcp_servers: { linear: { url: 'https://mcp.linear.app/mcp' } },
        },
        origins: {
          'mcp_servers.linear.url': {
            name: { type: 'user', file: '/home/.codex/config.toml' },
            version: 'v1',
          },
        },
      },
    });
    expect(sent('thread/start')).toBeUndefined();
    session.onMessage({ id: sent('hooks/list')!.id, result: HOOKS_LISTED });
    expect(frames().map((frame) => frame.method)).toEqual([
      'initialize',
      'initialized',
      'config/read',
      'hooks/list',
      'thread/start',
    ]);
    expect(configOf(sent('thread/start'))).toEqual({
      'mcp_servers.linear.enabled': false,
      ...PERMISSION_HOOK_OFF,
    });
  });

  it('stay on, said in a notice, and the thread still opens, when codex cannot list them', () => {
    const { session, sent } = conversationIn();
    const events = session.onMessage({
      id: sent('hooks/list')!.id,
      error: { code: -32601, message: 'method not found' },
    });
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(sent('thread/start')).toBeDefined();
    expect(configOf(sent('thread/start'))).toBeUndefined();
    expect(events).toContainEqual({
      type: 'notice',
      message: expect.stringContaining(
        'could not list its hooks (method not found), so your own PermissionRequest hooks stay on',
      ),
    });
  });

  it('are not listed for an internal probe, which asks nothing', () => {
    const { sent } = conversationIn({ approvalMode: undefined });
    expect(sent('hooks/list')).toBeUndefined();
    expect(configOf(sent('thread/start'))).toBeUndefined();
  });
});

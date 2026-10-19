import { describe, expect, it } from 'vitest';

import type { AgentEvent, AgentTurnInput, TurnIo } from '../adapter.types';
import { CodexSession } from './codex-session';
import type { CodexTurnOptions } from './codex-turn.driver';
import { codexTurnPolicy } from './utils/codex-policy.utils';

const THREAD = 'thread-model-test';
const TURN = 'turn-model-test';

function conversation(requestedModel?: string, reportedModel?: string) {
  const written: string[] = [];
  const io: TurnIo = {
    write: (payload) => {
      written.push(payload);
      return true;
    },
    emit: () => undefined,
  };
  const input: AgentTurnInput = {
    prompt: 'Hello',
    cwd: '/repo',
    model: requestedModel,
  };
  const optionsFor = (turnInput: AgentTurnInput): CodexTurnOptions => ({
    input: turnInput,
    developerInstructions: '',
    config: null,
    policy: codexTurnPolicy(turnInput.approvalMode),
    autoCompactTokens: null,
    mcpDisabled: [],
  });
  const session = new CodexSession(
    { clientVersion: 'test', turnOptions: optionsFor },
    input,
  );
  const request = (method: string) =>
    written
      .map((line) => JSON.parse(line) as { id: string; method: string })
      .findLast((frame) => frame.method === method)!;
  session.onStdinReady(io);
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

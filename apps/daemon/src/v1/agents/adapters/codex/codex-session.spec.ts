import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUP_KILL_GRACE_MS } from '../../utils/kill-tree';
import type { AgentEvent, AgentTurnInput, TurnIo } from '../adapter.types';
import {
  CODEX_ACTIVE_WRITER_RETRIES,
  CODEX_ACTIVE_WRITER_RETRY_MS,
} from './codex.const';
import { CodexSession } from './codex-session';
import type { CodexTurnOptions } from './codex-turn.driver';
import { codexTurnPolicy } from './utils/codex-policy.utils';

interface Frame {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

let written: string[];
let emitted: AgentEvent[];

function io(): TurnIo {
  return {
    write: (payload) => {
      written.push(payload);
      return true;
    },
    emit: (event) => emitted.push(event),
  };
}

function frames(): Frame[] {
  return written.map((payload) => JSON.parse(payload) as Frame);
}

function lastFrame(): Frame {
  const all = frames();
  return all[all.length - 1]!;
}

function frameFor(method: string): Frame {
  const found = frames().filter((frame) => frame.method === method);
  expect(found.length).toBeGreaterThan(0);
  return found[found.length - 1]!;
}

function turnInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return { prompt: 'Fix the test', cwd: '/repo', ...overrides };
}

function optionsFor(input: AgentTurnInput): CodexTurnOptions {
  return {
    input,
    developerInstructions: 'HOST BLOCK',
    config: null,
    policy: codexTurnPolicy(input.approvalMode),
  };
}

function newSession(first: AgentTurnInput): CodexSession {
  return new CodexSession(
    { clientVersion: '9.9.9', turnOptions: optionsFor },
    first,
  );
}

/** Feed one server line and collect what the session returns. */
function feed(
  session: CodexSession,
  message: Record<string, unknown>,
): AgentEvent[] {
  return session.onMessage(message);
}

const THREAD = '01a0e3aa-7dc4-7703-8a60-497958241fd1';
const TURN = '01a0e3aa-959f-7493-8c1f-01cff8862a2a';

const usage = (lastTotal: number, total: number) => ({
  threadId: THREAD,
  turnId: TURN,
  tokenUsage: {
    total: {
      totalTokens: total,
      inputTokens: total - 100,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 100,
      reasoningOutputTokens: 0,
    },
    last: {
      totalTokens: lastTotal,
      inputTokens: lastTotal - 50,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 50,
      reasoningOutputTokens: 0,
    },
    modelContextWindow: 258400,
  },
});

/** Open a session through the handshake and the thread, up to its turn/start. */
function openSession(first: AgentTurnInput = turnInput()): CodexSession {
  const session = newSession(first);
  session.onStdinReady(io());
  const start = frames().find(
    (frame) =>
      frame.method === 'thread/start' || frame.method === 'thread/resume',
  )!;
  emitted.push(
    ...feed(session, {
      id: start.id,
      result: { thread: { id: THREAD }, model: 'gpt-5.5' },
    }),
  );
  return session;
}

/** Announce a file-change item touching `path`, as codex does before asking. */
function startFileChange(session: CodexSession, path: string): void {
  feed(session, {
    method: 'item/started',
    params: {
      threadId: THREAD,
      turnId: TURN,
      item: {
        type: 'fileChange',
        id: 'f',
        changes: [
          { path, kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' },
        ],
      },
    },
  });
}

/** Answer the newest `turn/start` as codex does when it takes the turn. */
function acceptTurnStart(session: CodexSession, turnId = TURN): void {
  feed(session, {
    id: frameFor('turn/start').id,
    result: { turn: { id: turnId } },
  });
}

beforeEach(() => {
  written = [];
  emitted = [];
});

describe('opening a conversation', () => {
  it('pipelines the handshake and the thread, carrying the instruction block', () => {
    const session = newSession(
      turnInput({ model: 'gpt-5.5', approvalMode: 'ask' }),
    );
    session.onStdinReady(io());
    const sent = frames();
    expect(sent.map((frame) => frame.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
    ]);
    expect(sent[0]!.params).toMatchObject({
      clientInfo: { name: 'geniro', version: '9.9.9' },
      capabilities: { experimentalApi: true },
    });
    expect(sent[2]!.params).toMatchObject({
      cwd: '/repo',
      model: 'gpt-5.5',
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      developerInstructions: 'HOST BLOCK',
    });
  });

  it('announces the thread as the session, then sends the prompt with the turn’s own settings', () => {
    const session = newSession(
      turnInput({ model: 'gpt-5.5', effort: 'high', approvalMode: 'auto' }),
    );
    session.onStdinReady(io());
    const start = frameFor('thread/start');
    const events = feed(session, {
      id: start.id,
      result: { thread: { id: THREAD }, model: 'gpt-5.5' },
    });
    expect(events).toEqual([
      { type: 'session', sessionId: THREAD },
      { type: 'turn_model', model: 'gpt-5.5' },
    ]);
    expect(frameFor('turn/start').params).toMatchObject({
      threadId: THREAD,
      input: [{ type: 'text', text: 'Fix the test', text_elements: [] }],
      cwd: '/repo',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      model: 'gpt-5.5',
      effort: 'high',
      summary: 'auto',
    });
  });

  it('sends pasted images as local image inputs ahead of the words', () => {
    openSession(
      turnInput({
        images: [{ path: '/att/shot.png', mediaType: 'image/png' }],
      }),
    );
    expect(frameFor('turn/start').params?.input).toEqual([
      { type: 'localImage', path: '/att/shot.png' },
      { type: 'text', text: 'Fix the test', text_elements: [] },
    ]);
  });

  it('reports a failed handshake once, not once per frame pipelined behind it', () => {
    const session = newSession(turnInput());
    session.onStdinReady(io());
    const [initialize] = frames();
    expect(
      feed(session, {
        id: initialize!.id,
        error: { code: -32600, message: 'unsupported client' },
      }),
    ).toEqual([
      {
        type: 'error',
        message: 'codex: the handshake failed: unsupported client',
      },
    ]);
    expect(
      feed(session, {
        id: frameFor('thread/start').id,
        error: { code: -32600, message: 'not initialized' },
      }),
    ).toEqual([]);
  });

  it('resumes the run’s thread, and starts a fresh one — saying so — when codex cannot', () => {
    const session = newSession(turnInput({ resumeSessionId: THREAD }));
    session.onStdinReady(io());
    const resume = frameFor('thread/resume');
    expect(resume.params).toMatchObject({ threadId: THREAD });
    const events = feed(session, {
      id: resume.id,
      error: { code: -32600, message: 'thread not found' },
    });
    expect(events[0]).toMatchObject({ type: 'notice' });
    expect((events[0] as { message: string }).message).toContain(
      'thread not found',
    );
    expect(frameFor('thread/start').params).toMatchObject({ cwd: '/repo' });
  });
});

describe('a thread another codex process holds', () => {
  const HELD = {
    code: -32600,
    message: `thread ${THREAD} already has an active writer`,
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Refuse the newest `thread/resume` as held, then let any retry fire. */
  function refuseHeld(session: CodexSession): AgentEvent[] {
    const events = feed(session, {
      id: frameFor('thread/resume').id,
      error: HELD,
    });
    vi.advanceTimersByTime(CODEX_ACTIVE_WRITER_RETRY_MS);
    return events;
  }

  /** The first ask, and every retry after it, all refused. */
  function refuseUntilItFails(session: CodexSession): AgentEvent[] {
    let events: AgentEvent[] = [];
    for (
      let attempt = 0;
      attempt <= CODEX_ACTIVE_WRITER_RETRIES;
      attempt += 1
    ) {
      events = refuseHeld(session);
    }
    return events;
  }

  it('asks for longer than a process geniro is replacing takes to be killed', () => {
    // The holder is routinely geniro's own previous process, and a group still
    // alive GROUP_KILL_GRACE_MS after it is asked to end is killed outright —
    // so a resume refused for that whole stretch must still be asked again.
    const session = newSession(turnInput({ resumeSessionId: THREAD }));
    session.onStdinReady(io());
    const refusalsWithinGrace = Math.ceil(
      GROUP_KILL_GRACE_MS / CODEX_ACTIVE_WRITER_RETRY_MS,
    );
    for (let refusal = 0; refusal < refusalsWithinGrace; refusal += 1) {
      expect(refuseHeld(session)).toEqual([]);
    }
    feed(session, {
      id: frameFor('thread/resume').id,
      result: { thread: { id: THREAD }, model: 'gpt-5.5' },
    });
    expect(frameFor('turn/start').params).toMatchObject({ threadId: THREAD });
  });

  it('asks again while a process geniro just replaced lets go, then runs the turn', () => {
    const session = newSession(turnInput({ resumeSessionId: THREAD }));
    session.onStdinReady(io());
    expect(refuseHeld(session)).toEqual([]);
    const resumes = frames().filter(
      (frame) => frame.method === 'thread/resume',
    );
    expect(resumes).toHaveLength(2);
    feed(session, {
      id: resumes[1]!.id,
      result: { thread: { id: THREAD }, model: 'gpt-5.5' },
    });
    expect(frameFor('turn/start').params).toMatchObject({ threadId: THREAD });
    expect(frames().some((frame) => frame.method === 'thread/start')).toBe(
      false,
    );
  });

  it('fails the turn, rather than forking the conversation, once it stays held', () => {
    const session = newSession(turnInput({ resumeSessionId: THREAD }));
    session.onStdinReady(io());
    const events = refuseUntilItFails(session);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as { message: string }).message).toContain(
      'another codex process has it open',
    );
    // A fresh thread's id would replace the run's session for good.
    expect(frames().some((frame) => frame.method === 'thread/start')).toBe(
      false,
    );
  });

  it('drops a retry still waiting when a newer turn has opened', () => {
    // Sent under the new turn it would be that turn's resume twice over, and
    // its reply would begin the turn a second time.
    const session = newSession(turnInput({ resumeSessionId: THREAD }));
    session.onStdinReady(io());
    feed(session, { id: frameFor('thread/resume').id, error: HELD });
    session.openTurn(
      io(),
      turnInput({ prompt: 'next', resumeSessionId: THREAD }),
    );
    written = [];
    vi.advanceTimersByTime(CODEX_ACTIVE_WRITER_RETRY_MS);
    expect(written).toEqual([]);
  });

  it('asks nothing once the process has gone', () => {
    const session = newSession(turnInput({ resumeSessionId: THREAD }));
    let obstacle: string | null = null;
    session.onStdinReady({ ...io(), writeObstacle: () => obstacle });
    feed(session, { id: frameFor('thread/resume').id, error: HELD });
    obstacle = 'the process exited';
    written = [];
    vi.advanceTimersByTime(CODEX_ACTIVE_WRITER_RETRY_MS);
    expect(written).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('reopens the thread on the next turn, after one that could not', () => {
    const session = newSession(turnInput({ resumeSessionId: THREAD }));
    session.onStdinReady(io());
    refuseUntilItFails(session);
    written = [];
    session.openTurn(
      io(),
      turnInput({ prompt: 'again', resumeSessionId: THREAD }),
    );
    expect(frames().map((frame) => frame.method)).toEqual(['thread/resume']);
    feed(session, {
      id: frameFor('thread/resume').id,
      result: { thread: { id: THREAD } },
    });
    expect(frameFor('turn/start').params).toMatchObject({
      threadId: THREAD,
      input: [{ type: 'text', text: 'again', text_elements: [] }],
    });
  });
});

describe('a turn', () => {
  it('streams the answer and settles with the turn’s own usage and final text', () => {
    const session = openSession();
    const turnStart = frameFor('turn/start');
    feed(session, { id: turnStart.id, result: { turn: { id: TURN } } });
    expect(
      feed(session, {
        method: 'item/agentMessage/delta',
        params: { threadId: THREAD, turnId: TURN, itemId: 'm', delta: 'O' },
      }),
    ).toEqual([{ type: 'text_delta', text: 'O' }]);
    expect(
      feed(session, {
        method: 'thread/tokenUsage/updated',
        params: usage(16_000, 36_000),
      }),
    ).toEqual([
      {
        type: 'context_progress',
        contextTokens: 16_000,
        contextWindowTokens: 258400,
        contextModel: 'gpt-5.5',
      },
    ]);
    expect(
      feed(session, {
        method: 'item/completed',
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: {
            type: 'agentMessage',
            id: 'm',
            text: 'OK',
            phase: 'final_answer',
          },
        },
      }),
    ).toEqual([{ type: 'text', text: 'OK' }]);
    const [terminal] = feed(session, {
      method: 'turn/completed',
      params: {
        threadId: THREAD,
        turn: { id: TURN, status: 'completed', error: null, durationMs: 8316 },
      },
    });
    expect(terminal).toMatchObject({
      type: 'turn_complete',
      finalText: 'OK',
      stopReason: 'completed',
      usage: {
        // The first reading's own request, not the thread's whole total.
        inputTokens: 15_950,
        outputTokens: 50,
        contextTokens: 16_000,
        durationMs: 8316,
      },
    });
  });

  it('ignores a completion that names another turn, and settles on its own', () => {
    const session = openSession();
    acceptTurnStart(session);
    expect(
      feed(session, {
        method: 'turn/completed',
        params: {
          threadId: THREAD,
          turn: { id: 'a-turn-this-one-never-started', status: 'completed' },
        },
      }),
    ).toEqual([]);
    expect(
      feed(session, {
        method: 'turn/completed',
        params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
      })[0],
    ).toMatchObject({ type: 'turn_complete' });
  });

  it('says so when codex ran the turn on another model, and labels the context with it', () => {
    const session = openSession();
    acceptTurnStart(session);
    expect(
      feed(session, {
        method: 'model/rerouted',
        params: {
          threadId: THREAD,
          turnId: TURN,
          fromModel: 'gpt-5.5',
          toModel: 'gpt-5.4-mini',
          reason: 'safety',
        },
      }),
    ).toEqual([
      {
        type: 'notice',
        severity: 'info',
        message:
          'codex ran this turn on gpt-5.4-mini instead of gpt-5.5 (safety).',
      },
      { type: 'turn_model', model: 'gpt-5.4-mini' },
    ]);
    feed(session, {
      method: 'thread/tokenUsage/updated',
      params: usage(16_000, 36_000),
    });
    const [terminal] = feed(session, {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
    });
    expect(terminal).toMatchObject({
      type: 'turn_complete',
      usage: { contextModel: 'gpt-5.4-mini' },
    });
  });

  it('ignores a reroute that names no model to run on', () => {
    const session = openSession();
    acceptTurnStart(session);
    expect(
      feed(session, {
        method: 'model/rerouted',
        params: { threadId: THREAD, turnId: TURN, fromModel: 'gpt-5.5' },
      }),
    ).toEqual([]);
    expect(
      feed(session, {
        method: 'thread/tokenUsage/updated',
        params: usage(16_000, 36_000),
      }),
    ).toMatchObject([{ type: 'context_progress', contextModel: 'gpt-5.5' }]);
  });

  it('streams reasoning as it arrives, from the summary and from the raw text', () => {
    const session = openSession();
    acceptTurnStart(session);
    const delta = (method: string, text: string) =>
      feed(session, {
        method,
        params: { threadId: THREAD, turnId: TURN, itemId: 'r', delta: text },
      });
    expect(
      delta('item/reasoning/summaryTextDelta', 'Reading the test'),
    ).toEqual([{ type: 'reasoning_delta', text: 'Reading the test' }]);
    expect(delta('item/reasoning/textDelta', 'the cap is off by one')).toEqual([
      { type: 'reasoning_delta', text: 'the cap is off by one' },
    ]);
    // A delta with nothing in it is not an event.
    expect(delta('item/reasoning/textDelta', '')).toEqual([]);
  });

  it('settles a failed turn as an error carrying codex’s message', () => {
    const session = openSession();
    feed(session, {
      method: 'error',
      params: {
        threadId: THREAD,
        turnId: TURN,
        willRetry: false,
        error: {
          message: "You've hit your usage limit. Try again at 6:10 PM.",
        },
      },
    });
    expect(
      feed(session, {
        method: 'turn/completed',
        params: {
          threadId: THREAD,
          turn: { id: TURN, status: 'failed', error: null },
        },
      }),
    ).toEqual([
      {
        type: 'error',
        message: "You've hit your usage limit. Try again at 6:10 PM.",
      },
    ]);
  });

  it('reports a retry as a notice without settling the turn', () => {
    const session = openSession();
    const events = feed(session, {
      method: 'error',
      params: {
        threadId: THREAD,
        willRetry: true,
        error: { message: 'stream disconnected' },
      },
    });
    expect(events).toEqual([
      {
        type: 'notice',
        severity: 'warning',
        message: 'codex: stream disconnected — retrying',
      },
    ]);
  });

  it('keeps the plan as a snapshot task list', () => {
    const session = openSession();
    expect(
      feed(session, {
        method: 'turn/plan/updated',
        params: {
          threadId: THREAD,
          turnId: TURN,
          explanation: null,
          plan: [
            { step: 'Read the failing test', status: 'completed' },
            { step: 'Fix the parser', status: 'inProgress' },
            { step: 'Run the suite', status: 'pending' },
          ],
        },
      }),
    ).toEqual([
      {
        type: 'task_list',
        mode: 'snapshot',
        toolCallId: null,
        tasks: [
          {
            id: '1',
            title: 'Read the failing test',
            status: 'completed',
            activeForm: null,
          },
          {
            id: '2',
            title: 'Fix the parser',
            status: 'in_progress',
            activeForm: null,
          },
          {
            id: '3',
            title: 'Run the suite',
            status: 'pending',
            activeForm: null,
          },
        ],
      },
    ]);
  });
});

describe('approvals and questions', () => {
  it('parks a command request as a card and answers the verdict exactly once', () => {
    const session = openSession(turnInput({ approvalMode: 'ask' }));
    const [card] = feed(session, {
      id: 41,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: THREAD,
        turnId: TURN,
        itemId: 'c',
        command: 'npm test',
        cwd: '/repo',
      },
    });
    expect(card).toEqual({
      type: 'approval_request',
      id: 'n:41',
      toolName: 'shell',
      input: { command: 'npm test', cwd: '/repo' },
    });
    const reply = session.buildApprovalResponse('n:41', true);
    expect(JSON.parse(reply!)).toMatchObject({
      id: 41,
      result: { decision: 'accept' },
    });
    expect(session.buildApprovalResponse('n:41', true)).toBeUndefined();
  });

  it('lets `acceptEdits` file changes through without a card', () => {
    const session = openSession(turnInput({ approvalMode: 'acceptEdits' }));
    startFileChange(session, '/repo/src/a.ts');
    const events = feed(session, {
      id: 42,
      method: 'item/fileChange/requestApproval',
      params: { threadId: THREAD, turnId: TURN, itemId: 'f' },
    });
    expect(events).toEqual([]);
    expect(lastFrame()).toMatchObject({
      id: 42,
      result: { decision: 'accept' },
    });
  });

  it('still cards an `acceptEdits` change to a file outside the folder', () => {
    const session = openSession(turnInput({ approvalMode: 'acceptEdits' }));
    startFileChange(session, '/Users/me/.zshrc');
    const [card] = feed(session, {
      id: 49,
      method: 'item/fileChange/requestApproval',
      params: { threadId: THREAD, turnId: TURN, itemId: 'f' },
    });
    expect(card).toMatchObject({ type: 'approval_request' });
  });

  it('cards an MCP tool approval under the call’s own name and accepts it', () => {
    const session = openSession(turnInput({ approvalMode: 'ask' }));
    const args = { title: 'Probe', metrics: [{ label: 'Tests', value: '43' }] };
    feed(session, {
      method: 'item/started',
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: {
          type: 'mcpToolCall',
          id: 'exec-1',
          server: 'geniro-031a2e69',
          tool: 'show_metrics',
          status: 'inProgress',
          arguments: args,
        },
      },
    });
    const [card] = feed(session, {
      id: 50,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: THREAD,
        turnId: TURN,
        serverName: 'geniro-031a2e69',
        mode: 'form',
        message:
          'Allow the geniro-031a2e69 MCP server to run tool "show_metrics"?',
        requestedSchema: { type: 'object', properties: {} },
        _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: args },
      },
    });
    expect(card).toEqual({
      type: 'approval_request',
      id: 'n:50',
      toolName: 'mcp__geniro-031a2e69__show_metrics',
      input: args,
    });
    const reply = JSON.parse(session.buildApprovalResponse('n:50', true)!);
    expect(reply).toMatchObject({ id: 50 });
    expect(reply.result).toEqual({
      action: 'accept',
      content: {},
      _meta: null,
    });
  });

  it('cards a permissions request and grants what it asked for', () => {
    const session = openSession(turnInput({ approvalMode: 'ask' }));
    const permissions = { network: { enabled: true } };
    const [card] = feed(session, {
      id: 51,
      method: 'item/permissions/requestApproval',
      params: {
        threadId: THREAD,
        turnId: TURN,
        itemId: 'p',
        permissions,
        reason: 'fetch the schema',
      },
    });
    expect(card).toMatchObject({
      type: 'approval_request',
      input: { permissions, reason: 'fetch the schema' },
    });
    expect(
      JSON.parse(session.buildApprovalResponse('n:51', true)!).result,
    ).toEqual({ permissions, scope: 'turn' });
  });

  it('still cards a file change under `ask`', () => {
    const session = openSession(turnInput({ approvalMode: 'ask' }));
    const [card] = feed(session, {
      id: 43,
      method: 'item/fileChange/requestApproval',
      params: { threadId: THREAD, turnId: TURN, itemId: 'f' },
    });
    expect(card).toMatchObject({
      type: 'approval_request',
      toolName: 'apply_patch',
    });
  });

  it('raises a question as a card that needs the user', () => {
    const session = openSession(turnInput({ approvalMode: 'plan' }));
    const [card] = feed(session, {
      id: 44,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: THREAD,
        turnId: TURN,
        itemId: 'q',
        questions: [
          { id: 'q1', header: 'DB', question: 'Which DB?', options: [] },
        ],
      },
    });
    expect(card).toMatchObject({
      type: 'approval_request',
      toolName: 'request_user_input',
      requiresUserInteraction: true,
      questions: [
        {
          question: 'Which DB?',
          header: 'DB',
          options: [],
          multiSelect: false,
        },
      ],
    });
  });

  it('declines an MCP input request in-protocol and says so', () => {
    const session = openSession();
    const events = feed(session, {
      id: 45,
      method: 'mcpServer/elicitation/request',
      params: { threadId: THREAD, serverName: 's', mode: 'url' },
    });
    expect(events[0]).toMatchObject({ type: 'notice' });
    expect(lastFrame()).toMatchObject({
      id: 45,
      result: { action: 'decline' },
    });
  });

  it('refuses a request it does not know with method-not-found', () => {
    const session = openSession();
    feed(session, { id: 46, method: 'item/tool/call', params: {} });
    expect(lastFrame()).toMatchObject({ id: 46, error: { code: -32601 } });
  });
});

describe('mid-turn', () => {
  it('steers the running turn with a follow-up once codex has named it', () => {
    const session = openSession();
    expect(session.sendFollowUp({ text: 'also update the docs' })).toBe(false);
    feed(session, {
      method: 'turn/started',
      params: { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } },
    });
    expect(session.sendFollowUp({ text: 'also update the docs' })).toBe(true);
    expect(lastFrame()).toMatchObject({
      method: 'turn/steer',
      params: {
        threadId: THREAD,
        expectedTurnId: TURN,
        input: [
          { type: 'text', text: 'also update the docs', text_elements: [] },
        ],
      },
    });
  });

  it('says so, quoting the message, when codex will not take a follow-up into the turn', () => {
    const session = openSession();
    acceptTurnStart(session);
    session.sendFollowUp({ text: 'also update the docs' });
    const steer = frameFor('turn/steer');
    const events = feed(session, {
      id: steer.id,
      error: { code: -32600, message: 'turn already finishing' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'notice' });
    const { message } = events[0] as { message: string };
    expect(message).toContain('turn already finishing');
    expect(message).toContain('"also update the docs"');
  });

  it('quotes only the start of a long refused message', () => {
    const session = openSession();
    acceptTurnStart(session);
    session.sendFollowUp({ text: 'x'.repeat(200) });
    const events = feed(session, {
      id: frameFor('turn/steer').id,
      error: { code: -32600, message: 'no active turn' },
    });
    const { message } = events[0] as { message: string };
    expect(message).toContain(`"${'x'.repeat(59)}…"`);
    expect(message).not.toContain('x'.repeat(61));
  });

  it('still says so when a refused steer answers after the next turn has opened', () => {
    const session = openSession();
    acceptTurnStart(session);
    session.sendFollowUp({ text: 'also update the docs' });
    const steer = frameFor('turn/steer');
    feed(session, {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
    });
    session.openTurn(io(), turnInput({ prompt: 'next' }));
    // The only signal the user gets that the message was not taken, so it is
    // not dropped with the turn it belonged to — and it names the message, since
    // "this turn" would point at the wrong one.
    const events = feed(session, {
      id: steer.id,
      error: { code: -32600, message: 'no active turn' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'notice' });
    expect((events[0] as { message: string }).message).toContain(
      '"also update the docs"',
    );
  });

  it('takes a refused interrupt quietly, leaving the turn to settle', () => {
    const session = openSession();
    acceptTurnStart(session);
    const interrupt = JSON.parse(session.buildInterruptPayload()!) as Frame;
    expect(
      feed(session, {
        id: interrupt.id,
        error: { code: -32600, message: 'turn not running' },
      }),
    ).toEqual([]);
    expect(
      feed(session, {
        method: 'turn/completed',
        params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
      })[0],
    ).toMatchObject({ type: 'turn_complete' });
  });

  it('stops the turn in-protocol and settles it cancelled', () => {
    const session = openSession();
    expect(session.buildInterruptPayload()).toBeUndefined();
    feed(session, {
      method: 'turn/started',
      params: { threadId: THREAD, turn: { id: TURN } },
    });
    expect(JSON.parse(session.buildInterruptPayload()!)).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: THREAD, turnId: TURN },
    });
    expect(
      feed(session, {
        method: 'turn/completed',
        params: { threadId: THREAD, turn: { id: TURN, status: 'interrupted' } },
      }),
    ).toEqual([{ type: 'turn_cancelled' }]);
  });
});

describe('later turns on the kept process', () => {
  it('opens the next turn with a turn/start and no second handshake', () => {
    const session = openSession();
    feed(session, {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
    });
    written = [];
    session.openTurn(io(), turnInput({ prompt: 'next', approvalMode: 'ask' }));
    expect(frames().map((frame) => frame.method)).toEqual(['turn/start']);
    expect(frameFor('turn/start').params).toMatchObject({
      input: [{ type: 'text', text: 'next', text_elements: [] }],
      approvalPolicy: 'untrusted',
    });
  });

  it('fails a turn whose settings cannot be built, instead of throwing past it', () => {
    // `openTurn` must stay total: spawn-cli has already registered the turn.
    const session = new CodexSession(
      {
        clientVersion: '9.9.9',
        turnOptions: (input) => {
          if (input.prompt === 'boom') {
            throw new Error('no policy for this turn');
          }
          return optionsFor(input);
        },
      },
      turnInput(),
    );
    session.onStdinReady(io());
    feed(session, {
      id: frameFor('thread/start').id,
      result: { thread: { id: THREAD }, model: 'gpt-5.5' },
    });
    emitted = [];
    session.openTurn(io(), turnInput({ prompt: 'boom' }));
    expect(emitted).toEqual([
      {
        type: 'error',
        message: 'codex: could not open this turn: no policy for this turn',
      },
    ]);
  });

  it('drops a reply owed to a turn that has already ended', () => {
    const session = openSession();
    const firstTurnStart = frameFor('turn/start');
    session.openTurn(io(), turnInput({ prompt: 'next' }));
    expect(
      feed(session, {
        id: firstTurnStart.id,
        result: { turn: { id: 'stale' } },
      }),
    ).toEqual([]);
  });

  it('answers a request parked in one turn after the next has opened', () => {
    const session = openSession(turnInput({ approvalMode: 'ask' }));
    feed(session, {
      id: 41,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: THREAD, turnId: TURN, itemId: 'c', command: 'ls' },
    });
    feed(session, {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
    });
    session.openTurn(io(), turnInput({ prompt: 'next', approvalMode: 'ask' }));
    expect(
      JSON.parse(session.buildApprovalResponse('n:41', false)!),
    ).toMatchObject({ id: 41, result: { decision: 'decline' } });
  });

  it('fails a turn codex refused to start, once', () => {
    const session = openSession();
    const turnStart = frameFor('turn/start');
    expect(
      feed(session, {
        id: turnStart.id,
        error: { code: -32600, message: 'model not available' },
      }),
    ).toEqual([
      {
        type: 'error',
        message: 'codex: starting the turn failed: model not available',
      },
    ]);
    expect(
      feed(session, {
        method: 'turn/completed',
        params: { threadId: THREAD, turn: { id: TURN, status: 'failed' } },
      }),
    ).toEqual([]);
  });

  it('enters plan mode, and leaves it exactly once', () => {
    const session = openSession(
      turnInput({ approvalMode: 'plan', model: 'gpt-5.5' }),
    );
    expect(frameFor('turn/start').params?.collaborationMode).toEqual({
      mode: 'plan',
      settings: {
        model: 'gpt-5.5',
        reasoning_effort: null,
        developer_instructions: null,
      },
    });
    acceptTurnStart(session);
    session.openTurn(io(), turnInput({ approvalMode: 'ask' }));
    expect(frameFor('turn/start').params?.collaborationMode).toMatchObject({
      mode: 'default',
    });
    acceptTurnStart(session, 'turn-2');
    session.openTurn(io(), turnInput({ approvalMode: 'ask' }));
    expect(frameFor('turn/start').params).not.toHaveProperty(
      'collaborationMode',
    );
  });

  it('asks for plan mode again when codex refused the switch', () => {
    const session = openSession(
      turnInput({ approvalMode: 'plan', model: 'gpt-5.5' }),
    );
    feed(session, {
      id: frameFor('turn/start').id,
      error: { code: -32600, message: 'collaboration modes are experimental' },
    });
    session.openTurn(io(), turnInput({ approvalMode: 'plan' }));
    expect(frameFor('turn/start').params?.collaborationMode).toMatchObject({
      mode: 'plan',
    });
  });

  it('takes a resumed thread out of the plan mode it was left in', () => {
    const session = newSession(
      turnInput({ resumeSessionId: THREAD, approvalMode: 'auto' }),
    );
    session.onStdinReady(io());
    feed(session, {
      id: frameFor('thread/resume').id,
      result: {
        thread: { id: THREAD },
        model: 'gpt-5.5',
        collaborationMode: { mode: 'plan', settings: { model: 'gpt-5.5' } },
      },
    });
    expect(frameFor('turn/start').params?.collaborationMode).toMatchObject({
      mode: 'default',
    });
  });
});

describe('compaction', () => {
  it('answers `/compact` with codex’s own compaction and reports its sizes', () => {
    const session = openSession();
    feed(session, {
      method: 'thread/tokenUsage/updated',
      params: usage(120_000, 200_000),
    });
    feed(session, {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
    });
    written = [];
    session.openTurn(io(), turnInput({ prompt: '/compact' }));
    expect(frames().map((frame) => frame.method)).toEqual([
      'thread/compact/start',
    ]);
    const started = feed(session, {
      method: 'item/started',
      params: {
        threadId: THREAD,
        turnId: 'c1',
        item: { type: 'contextCompaction', id: 'cc' },
      },
    });
    expect(started).toEqual([
      {
        type: 'context_compacted',
        phase: 'started',
        trigger: 'manual',
        preTokens: 120_000,
        postTokens: null,
      },
    ]);
    feed(session, {
      method: 'thread/tokenUsage/updated',
      params: usage(5_742, 200_010),
    });
    const finished = feed(session, {
      method: 'item/completed',
      params: {
        threadId: THREAD,
        turnId: 'c1',
        item: { type: 'contextCompaction', id: 'cc' },
      },
    });
    expect(finished).toEqual([
      {
        type: 'context_compacted',
        phase: 'finished',
        trigger: 'manual',
        preTokens: 120_000,
        postTokens: 5_742,
      },
    ]);
  });
});

describe('automatic compaction', () => {
  it('reports a compaction codex ran by itself mid-turn as automatic', () => {
    const session = openSession();
    feed(session, {
      method: 'thread/tokenUsage/updated',
      params: usage(230_000, 300_000),
    });
    expect(
      feed(session, {
        method: 'item/started',
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: { type: 'contextCompaction', id: 'cc' },
        },
      }),
    ).toEqual([
      {
        type: 'context_compacted',
        phase: 'started',
        trigger: 'auto',
        preTokens: 230_000,
        postTokens: null,
      },
    ]);
  });
});

describe('sub-agents', () => {
  it('nests a sub-agent’s items under its spawn and closes it when its thread finishes', () => {
    const session = openSession();
    const spawnStarted = feed(session, {
      method: 'item/started',
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: {
          type: 'collabAgentToolCall',
          id: 'call_spawn',
          tool: 'spawnAgent',
          prompt: 'Review the parser\nfor edge cases',
          model: 'gpt-5.5',
        },
      },
    });
    expect(spawnStarted[1]).toMatchObject({
      type: 'subagent_info',
      id: 'call_spawn',
      label: 'Review the parser',
      prompt: 'Review the parser\nfor edge cases',
    });
    const spawnDone = feed(session, {
      method: 'item/completed',
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: {
          type: 'collabAgentToolCall',
          id: 'call_spawn',
          tool: 'spawnAgent',
          status: 'completed',
          receiverThreadIds: ['sub-1'],
          agentsStates: { 'sub-1': { status: 'running' } },
        },
      },
    });
    expect(spawnDone[1]).toMatchObject({
      type: 'subagent_info',
      id: 'call_spawn',
      backgroundOpen: true,
    });
    const nested = feed(session, {
      method: 'item/started',
      params: {
        threadId: 'sub-1',
        turnId: 'x',
        item: {
          type: 'commandExecution',
          id: 'sub_cmd',
          command: 'grep -n parse',
        },
      },
    });
    expect(nested).toEqual([
      {
        type: 'tool_call',
        id: 'sub_cmd',
        name: 'shell',
        input: { command: 'grep -n parse', cwd: null },
        kind: 'execute',
        parentToolUseId: 'call_spawn',
      },
    ]);
    // A sub-agent's turn ending is not this conversation's.
    const closed = feed(session, {
      method: 'turn/completed',
      params: { threadId: 'sub-1', turn: { id: 'x', status: 'completed' } },
    });
    expect(closed).toEqual([
      expect.objectContaining({
        type: 'subagent_info',
        id: 'call_spawn',
        backgroundOpen: false,
        backgroundOutcome: 'completed',
      }),
    ]);
    // Announced once, whichever report of the ending arrives second.
    expect(
      feed(session, {
        method: 'turn/completed',
        params: { threadId: 'sub-1', turn: { id: 'x', status: 'completed' } },
      }),
    ).toEqual([]);
  });

  it('closes a delegate a later collab call reports finished', () => {
    const session = openSession();
    feed(session, {
      method: 'item/completed',
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: {
          type: 'collabAgentToolCall',
          id: 'call_spawn',
          tool: 'spawnAgent',
          status: 'completed',
          receiverThreadIds: ['sub-1'],
          agentsStates: { 'sub-1': { status: 'running' } },
        },
      },
    });
    const waited = feed(session, {
      method: 'item/completed',
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: {
          type: 'collabAgentToolCall',
          id: 'call_wait',
          tool: 'wait',
          status: 'completed',
          receiverThreadIds: ['sub-1'],
          agentsStates: { 'sub-1': { status: 'errored' } },
        },
      },
    });
    expect(waited).toContainEqual(
      expect.objectContaining({
        type: 'subagent_info',
        id: 'call_spawn',
        backgroundOpen: false,
        backgroundOutcome: 'failed',
      }),
    );
  });

  it('ignores a thread it never saw spawned', () => {
    const session = openSession();
    expect(
      feed(session, {
        method: 'item/started',
        params: {
          threadId: 'stranger',
          item: { type: 'commandExecution', id: 'z', command: 'ls' },
        },
      }),
    ).toEqual([]);
  });
});

describe('reopening only', () => {
  it('reopens the thread and settles without sending a prompt', () => {
    const session = newSession(
      turnInput({ resumeSessionId: THREAD, resumeOnly: true }),
    );
    session.onStdinReady(io());
    const resume = frameFor('thread/resume');
    const events = feed(session, {
      id: resume.id,
      result: { thread: { id: THREAD }, model: 'gpt-5.5' },
    });
    expect(events).toContainEqual({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    expect(frames().some((frame) => frame.method === 'turn/start')).toBe(false);
  });

  it('fails a reopen codex refuses, without starting a fresh thread', () => {
    const session = newSession(
      turnInput({ resumeSessionId: THREAD, resumeOnly: true }),
    );
    session.onStdinReady(io());
    expect(
      feed(session, {
        id: frameFor('thread/resume').id,
        error: { code: -32600, message: 'thread not found' },
      }),
    ).toEqual([
      {
        type: 'error',
        message: 'codex could not reopen this conversation: thread not found',
      },
    ]);
    expect(frames().some((frame) => frame.method === 'thread/start')).toBe(
      false,
    );
  });

  it('refuses to start a fresh thread in the name of a reopen', () => {
    const session = newSession(turnInput({ resumeOnly: true }));
    session.onStdinReady(io());
    expect(emitted).toContainEqual({
      type: 'error',
      message: 'there is no conversation to reopen',
    });
    expect(frames().some((frame) => frame.method === 'thread/start')).toBe(
      false,
    );
  });
});

describe('sub-agents reported as subAgentActivity (codex 0.157.1)', () => {
  /**
   * The frames below are transcribed from this daemon's raw capture of a real
   * `spawn_agent` call on 0.157.1 (2026-09-30): no `collabAgentToolCall` at
   * all — a `subAgentActivity` on the parent thread at the launch and at the
   * end, with the sub-agent's own thread streaming in between, and its ending
   * arriving AFTER the parent's turn had completed.
   */
  const launch = (kind: string, id: string) => ({
    type: 'subAgentActivity',
    id,
    kind,
    agentThreadId: 'sub-7',
    agentPath: '/root/delayed_file',
  });

  function spawn(session: ReturnType<typeof openSession>) {
    return [
      ...feed(session, {
        method: 'item/started',
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: launch('started', 'call_u7z'),
        },
      }),
      ...feed(session, {
        method: 'item/completed',
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: launch('started', 'call_u7z'),
        },
      }),
    ];
  }

  it('opens a background delegate at the launch, named after its agent', () => {
    const session = openSession();
    const events = spawn(session);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_call',
        id: 'call_u7z',
        name: 'spawn_agent',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'subagent_info',
        id: 'call_u7z',
        label: 'delayed_file',
        backgroundOpen: true,
      }),
    );
    expect(
      events.some(
        (event) =>
          event.type === 'subagent_info' && event.backgroundOpen === false,
      ),
    ).toBe(false);
  });

  it('nests the sub-agent’s own items under the launch', () => {
    const session = openSession();
    spawn(session);
    expect(
      feed(session, {
        method: 'item/started',
        params: {
          threadId: 'sub-7',
          turnId: 'sub-turn',
          item: { type: 'commandExecution', id: 'exec-1', command: 'sleep 30' },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        type: 'tool_call',
        id: 'exec-1',
        parentToolUseId: 'call_u7z',
      }),
    ]);
  });

  it('closes it once, completed, when it ends after the parent’s turn', () => {
    const session = openSession();
    spawn(session);
    feed(session, {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
    });
    const byThread = feed(session, {
      method: 'turn/completed',
      params: {
        threadId: 'sub-7',
        turn: { id: 'sub-turn', status: 'completed' },
      },
    });
    const byActivity = feed(session, {
      method: 'item/started',
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: launch('completed', 'subagent-completed-sub-turn'),
      },
    });
    const closes = [...byThread, ...byActivity].filter(
      (event) =>
        event.type === 'subagent_info' && event.backgroundOpen === false,
    );
    expect(closes).toEqual([
      expect.objectContaining({
        id: 'call_u7z',
        backgroundOutcome: 'completed',
      }),
    ]);
    // The ending activity is not a second call.
    expect(byActivity.some((event) => event.type === 'tool_call')).toBe(false);
  });

  it('closes it from the parent-side activity when that arrives first', () => {
    const session = openSession();
    spawn(session);
    expect(
      feed(session, {
        method: 'item/started',
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: launch('completed', 'subagent-completed-sub-turn'),
        },
      }),
    ).toContainEqual(
      expect.objectContaining({
        type: 'subagent_info',
        id: 'call_u7z',
        backgroundOpen: false,
        backgroundOutcome: 'completed',
      }),
    );
  });

  it('reads an interrupted sub-agent turn as stopped, not failed', () => {
    const session = openSession();
    spawn(session);
    expect(
      feed(session, {
        method: 'turn/completed',
        params: {
          threadId: 'sub-7',
          turn: { id: 'sub-turn', status: 'interrupted' },
        },
      }),
    ).toContainEqual(expect.objectContaining({ backgroundOutcome: 'stopped' }));
  });
});

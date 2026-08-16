import { describe, expect, it } from 'vitest';

import {
  acpSessionListFrames,
  acpSessionListSettled,
  acpSessionLoadFrames,
  acpSessionLoadSettled,
  readAcpSessionList,
  readAcpSessionReplay,
} from './acp-sessions';

/** One JSON-RPC line as it arrives on the agent's stdout. */
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

const listReply = (sessions: unknown[]): string =>
  line({ jsonrpc: '2.0', id: 2, result: { sessions } });

const update = (sessionUpdate: string, rest: object): string =>
  line({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 's', update: { sessionUpdate, ...rest } },
  });

const text = (value: string): object => ({
  content: { type: 'text', text: value },
});

describe('acpSessionListFrames', () => {
  it('sends the folder filter only when there is one', () => {
    const [, filtered] = acpSessionListFrames({
      cwd: '/w',
      clientName: 'geniro',
      clientVersion: '1',
    });
    expect(JSON.parse(filtered as string).params).toEqual({ cwd: '/w' });

    const [, unfiltered] = acpSessionListFrames({
      cwd: null,
      clientName: 'geniro',
      clientVersion: '1',
    });
    // Not `{cwd: null}`: an explicit null is a parameter with a value, and an
    // agent validating its params would be within its rights to refuse it.
    expect(JSON.parse(unfiltered as string).params).toEqual({});
  });

  it('asks for no session of its own', () => {
    const frames = acpSessionListFrames({
      cwd: null,
      clientName: 'geniro',
      clientVersion: '1',
    });
    const methods = frames.map((frame) => JSON.parse(frame).method);
    expect(methods).toEqual(['initialize', 'session/list']);
  });
});

describe('acpSessionListSettled', () => {
  it('waits for the reply', () => {
    expect(acpSessionListSettled('')).toBe(false);
    expect(
      acpSessionListSettled(line({ jsonrpc: '2.0', id: 1, result: {} })),
    ).toBe(false);
  });

  it('settles on an ERROR too, rather than spending the whole deadline', () => {
    // An agent that does not implement the method answers -32601 at once.
    expect(
      acpSessionListSettled(
        line({ jsonrpc: '2.0', id: 2, error: { code: -32601 } }),
      ),
    ).toBe(true);
    expect(
      readAcpSessionList(
        line({ jsonrpc: '2.0', id: 2, error: { code: -32601 } }),
      ),
    ).toEqual([]);
  });
});

describe('readAcpSessionList', () => {
  it('reads the rows newest first, from either timestamp carrier', () => {
    const rows = readAcpSessionList(
      listReply([
        { sessionId: 'old', cwd: '/a', title: 'Old', updatedAt: 1000 },
        {
          sessionId: 'new',
          cwd: '/b',
          title: 'New',
          updatedAt: '2026-08-16T00:00:00.000Z',
        },
      ]),
    );
    expect(rows.map((row) => row.id)).toEqual(['new', 'old']);
    expect(rows[1]).toEqual({
      id: 'old',
      cwd: '/a',
      title: 'Old',
      updatedAt: 1000,
    });
  });

  it('skips a row missing its id instead of losing every other conversation', () => {
    const rows = readAcpSessionList(
      listReply([
        { cwd: '/a', title: 'no id' },
        { sessionId: '', title: 'blank id' },
        { sessionId: 'keeper', cwd: '/b', title: 'fine', updatedAt: 5 },
      ]),
    );
    expect(rows.map((row) => row.id)).toEqual(['keeper']);
  });

  it('reports an unstated field as null rather than as an empty label', () => {
    const rows = readAcpSessionList(listReply([{ sessionId: 'bare' }]));
    expect(rows[0]).toEqual({
      id: 'bare',
      cwd: null,
      title: null,
      updatedAt: null,
    });
  });
});

describe('acpSessionLoadFrames', () => {
  it('loads the session and asks for nothing else', () => {
    const frames = acpSessionLoadFrames({
      sessionId: 'abc',
      cwd: '/w',
      clientName: 'geniro',
      clientVersion: '1',
    });
    expect(frames.map((frame) => JSON.parse(frame).method)).toEqual([
      'initialize',
      'session/load',
    ]);
    // No MCP servers: this session is being READ, and dialling the folder's
    // servers would start every one of the user's own processes for a
    // transcript nobody is going to act on.
    expect(JSON.parse(frames[1] as string).params).toEqual({
      sessionId: 'abc',
      cwd: '/w',
      mcpServers: [],
    });
  });

  it('settles on the load reply, and on its refusal', () => {
    expect(acpSessionLoadSettled('')).toBe(false);
    expect(
      acpSessionLoadSettled(line({ jsonrpc: '2.0', id: 3, result: {} })),
    ).toBe(true);
    expect(
      acpSessionLoadSettled(
        line({ jsonrpc: '2.0', id: 3, error: { code: -32602 } }),
      ),
    ).toBe(true);
  });
});

describe('readAcpSessionReplay', () => {
  it('joins a run of chunks into ONE row per block', () => {
    // ACP sends a message as chunks with no "block complete" frame, so a row
    // per chunk writes a paragraph per word.
    const events = readAcpSessionReplay(
      update('agent_message_chunk', text('Hello ')) +
        update('agent_message_chunk', text('there')),
    );
    expect(events).toEqual([{ type: 'text', text: 'Hello there' }]);
  });

  it('keeps both sides of the conversation apart', () => {
    const events = readAcpSessionReplay(
      update('user_message_chunk', text('ask')) +
        update('agent_thought_chunk', text('hmm')) +
        update('agent_message_chunk', text('answer')),
    );
    expect(events).toEqual([
      { type: 'user_message', text: 'ask' },
      { type: 'reasoning', text: 'hmm' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('closes the open block when a tool call interrupts it', () => {
    // "said something → used a tool → said something" must stay readable
    // rather than collapsing into one block.
    const events = readAcpSessionReplay(
      update('agent_message_chunk', text('before')) +
        update('tool_call', {
          toolCallId: 't1',
          title: 'Read file',
          kind: 'read',
        }) +
        update('agent_message_chunk', text('after')),
    );
    expect(events).toEqual([
      { type: 'text', text: 'before' },
      {
        type: 'tool_call',
        id: 't1',
        name: 'Read file',
        input: null,
        kind: 'read',
      },
      { type: 'text', text: 'after' },
    ]);
  });

  it('ignores the live-only updates a record has no use for', () => {
    const events = readAcpSessionReplay(
      update('tool_call_update', { toolCallId: 't1', status: 'completed' }) +
        update('usage_update', { used: 10 }) +
        update('plan', { entries: [] }),
    );
    expect(events).toEqual([]);
  });

  it('reads nothing out of a stream that never answered', () => {
    expect(readAcpSessionReplay('not json\n')).toEqual([]);
  });
});

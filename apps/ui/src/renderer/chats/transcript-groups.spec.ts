import { describe, expect, it } from 'vitest';

import type { ChatItem } from '../../shared/contracts';
import {
  type CallBlockEntry,
  groupTranscript,
  toolCallSummary,
  type ToolGroupEntry,
  toolGroupSummary,
  toolResultText,
} from './transcript-groups';

let seq = 0;
function item(
  kind: ChatItem['kind'],
  payload: unknown,
  nodeId: string | null = 'orch',
): ChatItem {
  seq += 1;
  return {
    id: `i-${seq}`,
    runId: 'run-1',
    nodeId,
    seq,
    kind,
    role: null,
    payload,
    createdAt: 'now',
  };
}

const call = (
  name: string,
  id: string,
  input: unknown = {},
  nodeId: string | null = 'orch',
): ChatItem => item('tool_call', { id, name, input }, nodeId);
const result = (
  id: string,
  value: unknown = 'ok',
  nodeId: string | null = 'orch',
): ChatItem => item('tool_result', { id, name: null, result: value }, nodeId);

describe('groupTranscript', () => {
  it('collapses consecutive same-node tool calls into ONE group and pairs results by id', () => {
    const entries = groupTranscript([
      item('message', { text: 'hi' }, null),
      call('Bash', 't1'),
      result('t1', 'out-1'),
      call('Read', 't2'),
      result('t2', 'out-2'),
    ]);

    expect(entries.map((e) => e.type)).toEqual(['item', 'tools']);
    const group = entries[1] as ToolGroupEntry;
    expect(group.pairs).toHaveLength(2);
    expect(group.pairs[0]?.result).not.toBeNull();
    expect(group.pairs[1]?.result).not.toBeNull();
  });

  it('a same-node non-tool item closes the group; the next call opens a NEW one', () => {
    const entries = groupTranscript([
      call('Bash', 't1'),
      item('message', { text: 'thinking aloud' }),
      call('Bash', 't2'),
    ]);

    expect(entries.map((e) => e.type)).toEqual(['tools', 'item', 'tools']);
    expect((entries[0] as ToolGroupEntry).pairs).toHaveLength(1);
    expect((entries[2] as ToolGroupEntry).pairs).toHaveLength(1);
  });

  it("another node's interleaved rows do NOT shred a node's tool run", () => {
    // A parallel branch (a callee's status/message) lands between the
    // caller's tool calls — the caller's group must keep accumulating.
    const entries = groupTranscript([
      call('Bash', 't1'),
      item('status', { status: 'running' }, 'poet'),
      item('message', { text: 'haiku' }, 'poet'),
      call('Grep', 't2'),
      result('t1'),
      result('t2'),
    ]);

    const groups = entries.filter(
      (e): e is ToolGroupEntry => e.type === 'tools',
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.pairs).toHaveLength(2);
    expect(groups[0]?.pairs.every((p) => p.result !== null)).toBe(true);
  });

  it('a result pairs with its call even after the group closed', () => {
    const entries = groupTranscript([
      call('Bash', 't1'),
      item('message', { text: 'meanwhile…' }),
      result('t1', 'late result'),
    ]);

    expect(entries.map((e) => e.type)).toEqual(['tools', 'item']);
    expect((entries[0] as ToolGroupEntry).pairs[0]?.result).not.toBeNull();
  });

  it('drops mcp__geniro__* tool calls AND their results entirely', () => {
    // The dedicated call_* kinds already narrate agent calls — the raw
    // envelope JSON rows are duplication.
    const entries = groupTranscript([
      call('mcp__geniro__call_agent', 't1', { agent: 'poet' }),
      item('call_started', { callId: 'call-1', calleeNodeId: 'poet' }),
      result('t1', '{"status":"ok"}'),
    ]);

    expect(entries.map((e) => e.type)).toEqual(['item']);
    expect((entries[0] as { item: ChatItem }).item.kind).toBe('call_started');
  });

  it('an orphan tool_result (no known call) stays a plain item entry', () => {
    const entries = groupTranscript([result('mystery', 'out')]);
    expect(entries.map((e) => e.type)).toEqual(['item']);
  });
});

describe('groupTranscript — call blocks', () => {
  const startCall = (
    callId: string,
    callee: string,
    message = 'do the thing',
    mode = 'async',
  ): ChatItem =>
    item(
      'call_started',
      { callId, calleeNodeId: callee, mode, message },
      'orch',
    );
  const tagged = (
    kind: ChatItem['kind'],
    payload: Record<string, unknown>,
    nodeId: string,
    callId: string,
  ): ChatItem => item(kind, { ...payload, callId, nodeId }, nodeId);
  const isBlock = (e: { type: string }): e is CallBlockEntry =>
    e.type === 'call-block';

  it('folds a tagged callee sub-turn into ONE block — status rows become the header status, not rows', () => {
    const entries = groupTranscript([
      startCall('call-1', 'poet', 'Write a haiku.'),
      tagged('status', { status: 'running' }, 'poet', 'call-1'),
      tagged('message', { text: 'Waves rise…' }, 'poet', 'call-1'),
      tagged('status', { status: 'completed' }, 'poet', 'call-1'),
    ]);

    expect(entries).toHaveLength(1);
    const block = entries[0] as CallBlockEntry;
    expect(block.type).toBe('call-block');
    expect(block.callId).toBe('call-1');
    expect(block.calleeNodeId).toBe('poet');
    expect(block.callerNodeId).toBe('orch');
    expect(block.mode).toBe('async');
    expect(block.message).toBe('Write a haiku.');
    expect(block.status).toBe('completed');
    // Inside: ONLY the message — the old "▸ started"/"✓ finished" pair is
    // the header now.
    expect(block.entries).toHaveLength(1);
    expect(block.entries[0]?.type).toBe('item');
  });

  it('two parallel calls to the SAME callee node keep their items apart by callId', () => {
    const entries = groupTranscript([
      startCall('call-1', 'worker', 'rivers'),
      startCall('call-2', 'worker', 'mountains'),
      tagged('status', { status: 'running' }, 'worker', 'call-1'),
      tagged('status', { status: 'running' }, 'worker', 'call-2'),
      // Deliberately interleaved: call-2's text arrives first.
      tagged('message', { text: 'about mountains' }, 'worker', 'call-2'),
      tagged('message', { text: 'about rivers' }, 'worker', 'call-1'),
    ]);

    const blocks = entries.filter(isBlock);
    expect(blocks).toHaveLength(2);
    const texts = (block: CallBlockEntry): string =>
      JSON.stringify(block.entries);
    expect(texts(blocks[0]!)).toContain('about rivers');
    expect(texts(blocks[0]!)).not.toContain('about mountains');
    expect(texts(blocks[1]!)).toContain('about mountains');
    expect(blocks[0]!.status).toBe('running');
  });

  it('tool calls inside a sub-turn still group Claude-style within the block', () => {
    const entries = groupTranscript([
      startCall('call-1', 'researcher'),
      tagged('status', { status: 'running' }, 'researcher', 'call-1'),
      tagged(
        'tool_call',
        { id: 't1', name: 'Bash', input: { command: 'pwd' } },
        'researcher',
        'call-1',
      ),
      tagged(
        'tool_result',
        { id: 't1', name: null, result: '/proj' },
        'researcher',
        'call-1',
      ),
    ]);

    const block = entries[0] as CallBlockEntry;
    expect(block.entries).toHaveLength(1);
    expect(block.entries[0]?.type).toBe('tools');
  });

  it('UNTAGGED (legacy) callee items stay in the main flow with the flat call row', () => {
    const entries = groupTranscript([
      startCall('call-1', 'poet'),
      item('status', { status: 'running' }, 'poet'),
      item('message', { text: 'legacy haiku' }, 'poet'),
    ]);

    expect(entries.filter(isBlock)).toHaveLength(0);
    expect(entries.map((e) => e.type)).toEqual(['item', 'item', 'item']);
  });

  it('a tagged approval_request is NEVER claimed — a pending card must stay answerable in the main flow', () => {
    const entries = groupTranscript([
      startCall('call-1', 'poet'),
      tagged('status', { status: 'running' }, 'poet', 'call-1'),
      tagged(
        'approval_request',
        { id: 'req-1', toolName: 'Bash', input: {} },
        'poet',
        'call-1',
      ),
    ]);

    const block = entries.find(isBlock)!;
    expect(JSON.stringify(block.entries)).not.toContain('req-1');
    expect(
      entries.some(
        (e) => e.type === 'item' && e.item.kind === 'approval_request',
      ),
    ).toBe(true);
  });

  it("the caller's call_result receipt stays in the main flow, never inside the block", () => {
    const entries = groupTranscript([
      startCall('call-1', 'poet'),
      tagged('status', { status: 'running' }, 'poet', 'call-1'),
      tagged('status', { status: 'completed' }, 'poet', 'call-1'),
      item(
        'call_result',
        { callId: 'call-1', calleeNodeId: 'poet', status: 'ok', result: {} },
        'orch',
      ),
    ]);

    expect(entries.map((e) => e.type)).toEqual(['call-block', 'item']);
  });
});

describe('toolGroupSummary', () => {
  it('counts tools, commands, edited and created files', () => {
    const pairs = groupTranscript([
      call('Bash', 't1', { command: 'ls' }),
      call('Bash', 't2', { command: 'pwd' }),
      call('Edit', 't3', {
        file_path: '/a.ts',
        old_string: 'x',
        new_string: 'y',
      }),
      call('Write', 't4', { file_path: '/b.ts', content: 'hello' }),
      call('Read', 't5', { file_path: '/c.ts' }),
    ])[0] as ToolGroupEntry;

    expect(toolGroupSummary(pairs.pairs)).toBe(
      'Used 5 tools · ran 2 commands · edited 1 file · created 1 file',
    );
  });

  it('a single plain tool reads "Used 1 tool"', () => {
    const group = groupTranscript([
      call('Read', 't1', { file_path: '/a.ts' }),
    ])[0] as ToolGroupEntry;
    expect(toolGroupSummary(group.pairs)).toBe('Used 1 tool');
  });
});

describe('toolCallSummary', () => {
  it('previews the argument that names the action', () => {
    expect(toolCallSummary(call('Bash', 't', { command: 'ls -la' }))).toBe(
      'ls -la',
    );
    expect(toolCallSummary(call('Edit', 't', { file_path: '/x.ts' }))).toBe(
      '/x.ts',
    );
    expect(
      toolCallSummary(
        call('AskUserQuestion', 't', {
          questions: [{ question: 'Which color?' }],
        }),
      ),
    ).toBe('Which color?');
  });

  it('falls back to compact JSON for unknown input shapes', () => {
    expect(toolCallSummary(call('Custom', 't', { foo: 1 }))).toBe('{"foo":1}');
  });
});

describe('toolResultText', () => {
  it('passes strings through and joins Claude text-block arrays', () => {
    expect(toolResultText('plain')).toBe('plain');
    expect(
      toolResultText([
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ]),
    ).toBe('one\ntwo');
  });

  it('pretty-prints anything else as JSON', () => {
    expect(toolResultText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

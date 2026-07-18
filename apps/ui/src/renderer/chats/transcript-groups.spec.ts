import { describe, expect, it } from 'vitest';

import type { ChatItem } from '../../shared/contracts';
import {
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

import { describe, expect, it } from 'vitest';

import {
  fileChangeDiffs,
  finishedAgentsOf,
  firstLine,
  itemCompletedEvents,
  itemStartedEvents,
  readCodexItem,
  receiverThreadsOf,
  spawnsSubagent,
} from './codex-items.utils';

const item = (record: Record<string, unknown>) => readCodexItem(record)!;

describe('firstLine', () => {
  it('keeps the first line, trimmed, whole when no cap is given', () => {
    expect(firstLine(`  ${'x'.repeat(120)}  \nsecond`)).toBe('x'.repeat(120));
  });

  it('cuts a line past the cap to exactly the cap, keeping its start', () => {
    expect(firstLine('Review the parser for edge cases', 11)).toBe(
      'Review the…',
    );
    expect(firstLine('short', 80)).toBe('short');
  });
});

describe('readCodexItem', () => {
  it('reads the type and id, and refuses a record missing either', () => {
    expect(readCodexItem({ type: 'agentMessage', id: 'msg_1' })?.id).toBe(
      'msg_1',
    );
    expect(readCodexItem({ type: 'agentMessage' })).toBeNull();
    expect(readCodexItem({ id: 'x' })).toBeNull();
    expect(readCodexItem('nope')).toBeNull();
  });
});

describe('itemStartedEvents', () => {
  it('opens a command as an execute tool call', () => {
    expect(
      itemStartedEvents(
        item({
          type: 'commandExecution',
          id: 'call_1',
          command: 'ls -la',
          cwd: '/repo',
          status: 'inProgress',
        }),
      ),
    ).toEqual([
      {
        type: 'tool_call',
        id: 'call_1',
        name: 'shell',
        input: { command: 'ls -la', cwd: '/repo' },
        kind: 'execute',
      },
    ]);
  });

  it('names an MCP call the way every consumer recognises one', () => {
    const [event] = itemStartedEvents(
      item({
        type: 'mcpToolCall',
        id: 'call_2',
        server: 'geniro-0123abcd',
        tool: 'report_findings',
        arguments: { findings: [] },
      }),
    );
    expect(event).toMatchObject({
      type: 'tool_call',
      name: 'mcp__geniro-0123abcd__report_findings',
      input: { findings: [] },
    });
  });

  it('opens a file change as an edit with its paths as locations', () => {
    const [event] = itemStartedEvents(
      item({
        type: 'fileChange',
        id: 'call_3',
        changes: [{ path: '/repo/a.ts', kind: { type: 'update' }, diff: '' }],
      }),
    );
    expect(event).toMatchObject({
      name: 'apply_patch',
      kind: 'edit',
      locations: [{ path: '/repo/a.ts', line: null }],
    });
  });

  it('lists a move’s destination among the files the change touches', () => {
    const [event] = itemStartedEvents(
      item({
        type: 'fileChange',
        id: 'call_4',
        changes: [
          {
            path: '/repo/a.ts',
            kind: { type: 'update', move_path: '/repo/lib/a.ts' },
            diff: '',
          },
        ],
      }),
    );
    expect(event).toMatchObject({
      locations: [
        { path: '/repo/a.ts', line: null },
        { path: '/repo/lib/a.ts', line: null },
      ],
    });
  });

  it('opens nothing for an item that is not a tool call', () => {
    expect(
      itemStartedEvents(item({ type: 'agentMessage', id: 'm', text: '' })),
    ).toEqual([]);
    expect(itemStartedEvents(item({ type: 'reasoning', id: 'r' }))).toEqual([]);
  });
});

describe('itemCompletedEvents', () => {
  it('turns a finished agent message into its text', () => {
    expect(
      itemCompletedEvents(
        item({
          type: 'agentMessage',
          id: 'm',
          text: 'OK',
          phase: 'final_answer',
        }),
      ),
    ).toEqual([{ type: 'text', text: 'OK' }]);
  });

  it('prefers a reasoning summary over its raw content', () => {
    expect(
      itemCompletedEvents(
        item({
          type: 'reasoning',
          id: 'r',
          summary: ['Looked at the tests.'],
          content: ['raw chain'],
        }),
      ),
    ).toEqual([{ type: 'reasoning', text: 'Looked at the tests.' }]);
    expect(
      itemCompletedEvents(item({ type: 'reasoning', id: 'r2', summary: [] })),
    ).toEqual([]);
  });

  it('closes a command with its output, failed on a non-zero exit', () => {
    expect(
      itemCompletedEvents(
        item({
          type: 'commandExecution',
          id: 'call_1',
          command: 'false',
          status: 'completed',
          aggregatedOutput: 'boom',
          exitCode: 1,
        }),
      ),
    ).toEqual([
      {
        type: 'tool_result',
        id: 'call_1',
        name: 'shell',
        result: 'boom',
        isError: true,
      },
    ]);
  });

  it('says a declined command was declined instead of showing no output', () => {
    const [event] = itemCompletedEvents(
      item({
        type: 'commandExecution',
        id: 'c',
        command: 'rm -rf /',
        status: 'declined',
      }),
    );
    expect(event).toMatchObject({
      isError: true,
      result: 'The command was declined.',
    });
  });

  it('carries a failed MCP call’s error as its result', () => {
    const [event] = itemCompletedEvents(
      item({
        type: 'mcpToolCall',
        id: 'c',
        server: 's',
        tool: 't',
        status: 'failed',
        error: { message: 'server gone' },
      }),
    );
    expect(event).toMatchObject({ result: 'server gone', isError: true });
  });
});

describe('fileChangeDiffs', () => {
  it('rebuilds before and after from a unified diff’s hunks', () => {
    expect(
      fileChangeDiffs([
        {
          path: '/repo/a.ts',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n const c = 4;\n',
        },
      ]),
    ).toEqual([
      {
        path: '/repo/a.ts',
        oldText: 'const a = 1;\nconst b = 2;\nconst c = 4;\n',
        newText: 'const a = 1;\nconst b = 3;\nconst c = 4;\n',
      },
    ]);
  });

  it('labels a move with where the file is going', () => {
    // The destination is only on the kind; a card that showed the source
    // alone would have the user approve a move they never saw.
    expect(
      fileChangeDiffs([
        {
          path: '/repo/a.ts',
          kind: { type: 'update', move_path: '/repo/lib/a.ts' },
          diff: '@@ -1 +1 @@\n-x\n+y\n',
        },
      ])[0]?.path,
    ).toBe('/repo/a.ts → /repo/lib/a.ts');
  });

  it('reads a diff without hunks as a whole added file', () => {
    expect(
      fileChangeDiffs([
        { path: '/repo/new.md', kind: { type: 'add' }, diff: '# Title\n' },
      ]),
    ).toEqual([{ path: '/repo/new.md', oldText: null, newText: '# Title\n' }]);
  });

  it('reads a deleted file’s content as its old text', () => {
    expect(
      fileChangeDiffs([
        { path: '/repo/gone.md', kind: 'delete', diff: 'bye\n' },
      ]),
    ).toEqual([{ path: '/repo/gone.md', oldText: 'bye\n', newText: '' }]);
  });
});

describe('sub-agent collab calls', () => {
  const spawn = item({
    type: 'collabAgentToolCall',
    id: 'call_spawn',
    tool: 'spawnAgent',
    status: 'completed',
    receiverThreadIds: ['thread-a', 'thread-b'],
    agentsStates: {
      'thread-a': { status: 'completed', message: null },
      'thread-b': { status: 'running', message: null },
      'thread-c': { status: 'errored', message: 'crashed' },
    },
  });

  it('recognises a spawn and the threads it opened', () => {
    expect(spawnsSubagent(spawn)).toBe(true);
    expect(receiverThreadsOf(spawn)).toEqual(['thread-a', 'thread-b']);
    expect(
      spawnsSubagent(
        item({ type: 'collabAgentToolCall', id: 'w', tool: 'wait' }),
      ),
    ).toBe(false);
  });

  it('reports only the agents whose state is terminal, with how each ended', () => {
    expect(finishedAgentsOf(spawn)).toEqual([
      { threadId: 'thread-a', outcome: 'completed' },
      { threadId: 'thread-c', outcome: 'failed' },
    ]);
  });
});

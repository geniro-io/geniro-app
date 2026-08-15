import { describe, expect, it } from 'vitest';

import {
  contextUsageRequestLine,
  readContextUsageReply,
} from './claude-context-usage.utils';

/** The shape probed live on 2.1.232, trimmed to the fields the reader uses. */
function reply(
  requestId: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: body },
  };
}

const LIVE_BODY = {
  categories: [
    { name: 'System prompt', tokens: 3386, color: 'promptBorder' },
    { name: 'System tools', tokens: 8825, color: 'inactive' },
    {
      name: 'MCP tools (deferred)',
      tokens: 273876,
      color: 'inactive',
      isDeferred: true,
    },
    {
      name: 'System tools (deferred)',
      tokens: 17246,
      color: 'inactive',
      isDeferred: true,
    },
    { name: 'Custom agents', tokens: 3009, color: 'permission' },
    { name: 'Memory files', tokens: 59058, color: 'claude' },
    { name: 'Skills', tokens: 8687, color: 'warning' },
    { name: 'Messages', tokens: 15633, color: 'purple_FOR_SUBAGENTS_ONLY' },
    { name: 'Free space', tokens: 901402, color: 'promptBorder' },
  ],
  totalTokens: 98598,
  maxTokens: 1000000,
  rawMaxTokens: 1000000,
  model: 'claude-opus-5[1m]',
  autoCompactThreshold: 967000,
  isAutoCompactEnabled: true,
  memoryFiles: [
    { path: '/proj/CLAUDE.md', type: 'Project', tokens: 45947 },
    { path: '/mem/MEMORY.md', type: 'AutoMem', tokens: 50 },
  ],
  mcpTools: [
    { name: 'mcp__a__one', serverName: 'a', tokens: 700, isLoaded: false },
    { name: 'mcp__a__two', serverName: 'a', tokens: 300, isLoaded: true },
    { name: 'mcp__b__one', serverName: 'b', tokens: 5000, isLoaded: false },
  ],
  gridRows: [[{ color: 'claude', isFilled: true }]],
};

describe('contextUsageRequestLine', () => {
  it('writes the control request the CLI answers, newline-terminated', () => {
    const line = contextUsageRequestLine('req-1');

    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      type: 'control_request',
      request_id: 'req-1',
      request: { subtype: 'get_context_usage' },
    });
  });
});

describe('readContextUsageReply', () => {
  it('projects the live reply into the agent-agnostic breakdown', () => {
    const usage = readContextUsageReply(reply('req-1', LIVE_BODY), 'req-1');

    expect(usage).not.toBeNull();
    expect(usage?.totalTokens).toBe(98598);
    expect(usage?.maxTokens).toBe(1000000);
    expect(usage?.model).toBe('claude-opus-5[1m]');
    expect(usage?.autoCompactAtTokens).toBe(967000);
    expect(usage?.autoCompactEnabled).toBe(true);
  });

  it('drops the Free space row — it is the remainder, not a category', () => {
    // The pin: keeping it would double every "how full is the window" sum a
    // consumer takes over the list.
    const usage = readContextUsageReply(reply('req-1', LIVE_BODY), 'req-1');

    expect(usage?.categories.map((row) => row.name)).not.toContain(
      'Free space',
    );
    expect(
      usage?.categories
        .filter((row) => !row.deferred)
        .reduce((sum, row) => sum + row.tokens, 0),
    ).toBe(LIVE_BODY.totalTokens);
  });

  it('marks a deferred category as deferred, keeping it out of the total', () => {
    const usage = readContextUsageReply(reply('req-1', LIVE_BODY), 'req-1');

    const mcp = usage?.categories.find((row) => row.name.startsWith('MCP'));
    expect(mcp).toEqual({
      name: 'MCP tools (deferred)',
      tokens: 273876,
      deferred: true,
    });
    expect(
      usage?.categories.find((row) => row.name === 'System prompt')?.deferred,
    ).toBe(false);
  });

  it('folds the per-tool rows into one row per server, heaviest first', () => {
    const usage = readContextUsageReply(reply('req-1', LIVE_BODY), 'req-1');

    expect(usage?.servers).toEqual([
      { name: 'b', tokens: 5000, toolCount: 1, loadedToolCount: 0 },
      { name: 'a', tokens: 1000, toolCount: 2, loadedToolCount: 1 },
    ]);
  });

  it('keeps the CLI’s own word for where a memory file came from', () => {
    const usage = readContextUsageReply(reply('req-1', LIVE_BODY), 'req-1');

    expect(usage?.memoryFiles).toEqual([
      { path: '/proj/CLAUDE.md', kind: 'Project', tokens: 45947 },
      { path: '/mem/MEMORY.md', kind: 'AutoMem', tokens: 50 },
    ]);
  });

  it('ignores a reply to somebody ELSE’s question', () => {
    // Two readouts open at once is ordinary; taking the first reply that shows
    // up would give one of them a snapshot of a different moment.
    expect(
      readContextUsageReply(reply('other', LIVE_BODY), 'req-1'),
    ).toBeNull();
  });

  it('ignores every line that is not a control response', () => {
    expect(readContextUsageReply({ type: 'assistant' }, 'req-1')).toBeNull();
    expect(readContextUsageReply('not an object', 'req-1')).toBeNull();
    expect(readContextUsageReply(null, 'req-1')).toBeNull();
  });

  it('reads a refusal as no answer', () => {
    const refused = {
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: 'req-1',
        error: 'unknown subtype',
      },
    };

    expect(readContextUsageReply(refused, 'req-1')).toBeNull();
  });

  it('reads a reply carrying nothing showable as no answer', () => {
    // An empty projection would put a panel on screen under a heading
    // promising figures, which is indistinguishable from a bug.
    expect(
      readContextUsageReply(reply('req-1', { totalTokens: 5 }), 'req-1'),
    ).toBeNull();
  });

  it('leaves autoCompactEnabled null when the build does not say', () => {
    // Absent is not the same as off, and a coerced false would report auto
    // compaction disabled on a session where it is running.
    const usage = readContextUsageReply(
      reply('req-1', { ...LIVE_BODY, isAutoCompactEnabled: undefined }),
      'req-1',
    );

    expect(usage?.autoCompactEnabled).toBeNull();
  });

  it('drops a category row whose shape has drifted, keeping the rest', () => {
    const usage = readContextUsageReply(
      reply('req-1', {
        ...LIVE_BODY,
        categories: [
          { name: 'System prompt', tokens: 3386 },
          { name: 'Broken', tokens: 'lots' },
          { tokens: 12 },
        ],
      }),
      'req-1',
    );

    expect(usage?.categories).toEqual([
      { name: 'System prompt', tokens: 3386, deferred: false },
    ]);
  });
});

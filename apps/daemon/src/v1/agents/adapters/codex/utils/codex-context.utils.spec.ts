import { describe, expect, it } from 'vitest';

import type { CodexMcpServerStatus, CodexThreadFacts } from '../codex.types';
import {
  codexContextRequestLine,
  codexContextUsage,
  codexLastRequest,
  readCodexContextReply,
} from './codex-context.utils';

const LAST = {
  totalTokens: 40_000,
  inputTokens: 39_000,
  cachedInputTokens: 30_000,
  cacheWriteInputTokens: 1_000,
  outputTokens: 1_000,
  reasoningOutputTokens: 400,
};

const FACTS: CodexThreadFacts = {
  usage: { total: LAST, last: LAST, modelContextWindow: 258_400 },
  instructionSources: ['/home/u/.codex/AGENTS.md'],
  model: 'gpt-5.5',
  autoCompactTokens: 200_000,
};

function server(
  name: string,
  runtimeStatus: string | null,
  toolCount: number,
): CodexMcpServerStatus {
  return {
    name,
    runtimeStatus,
    authStatus: 'unsupported',
    pluginId: null,
    httpOrigin: null,
    toolCount,
    toolsError: null,
  };
}

describe('codexContextRequestLine / readCodexContextReply', () => {
  it('asks about the live thread and reads only its own reply', () => {
    const frame = JSON.parse(codexContextRequestLine('q-1', 'T1')) as {
      id: string;
      method: string;
      params: Record<string, unknown>;
    };
    expect(frame).toMatchObject({
      id: 'q-1',
      method: 'mcpServerStatus/list',
      params: { threadId: 'T1', detail: 'toolsAndAuthOnly' },
    });
    expect(
      readCodexContextReply({ id: 'other', result: {} }, 'q-1'),
    ).toBeNull();
    expect(
      readCodexContextReply({ method: 'item/started', params: {} }, 'q-1'),
    ).toBeNull();
    expect(
      readCodexContextReply(
        {
          id: 'q-1',
          result: {
            data: [
              { name: 'fs', runtimeStatus: 'connected', tools: { a: {} } },
            ],
          },
        },
        'q-1',
      )?.servers?.map((s) => [s.name, s.toolCount]),
    ).toEqual([['fs', 1]]);
  });

  it('reads a refusal as no servers, not as some other line', () => {
    expect(
      readCodexContextReply(
        { id: 'q-1', error: { code: -1, message: 'no thread' } },
        'q-1',
      ),
    ).toEqual({ servers: null });
  });
});

describe('codexLastRequest', () => {
  it('reports input FRESH, with cache reads and writes split out', () => {
    expect(codexLastRequest(LAST)).toEqual({
      inputTokens: 8_000,
      cachedInputTokens: 30_000,
      cacheWriteInputTokens: 1_000,
      outputTokens: 1_000,
      reasoningOutputTokens: 400,
    });
  });
});

describe('codexContextUsage', () => {
  it('states the size, the window and the split, and lists by name without figures', () => {
    const usage = codexContextUsage(FACTS, [
      server('fs', 'connected', 4),
      server('off', 'disabled', 0),
    ]);
    expect(usage).toEqual({
      categories: [],
      totalTokens: 40_000,
      maxTokens: 258_400,
      model: 'gpt-5.5',
      autoCompactAtTokens: 200_000,
      autoCompactEnabled: true,
      memoryFiles: [
        { path: '/home/u/.codex/AGENTS.md', kind: null, tokens: null },
      ],
      // Only what is connected is in the window; codex prices no server.
      servers: [{ name: 'fs', tokens: null, toolCount: 4, loadedToolCount: 4 }],
      lastRequest: codexLastRequest(LAST),
    });
  });

  it('says nothing about auto-compaction geniro did not set', () => {
    const usage = codexContextUsage({ ...FACTS, autoCompactTokens: null }, []);
    expect(usage.autoCompactAtTokens).toBeNull();
    expect(usage.autoCompactEnabled).toBeNull();
  });

  it('still lists the servers when the thread has reported nothing yet', () => {
    const usage = codexContextUsage(null, [server('fs', 'connected', 2)]);
    expect(usage.totalTokens).toBeNull();
    expect(usage.lastRequest).toBeNull();
    expect(usage.servers).toHaveLength(1);
  });
});

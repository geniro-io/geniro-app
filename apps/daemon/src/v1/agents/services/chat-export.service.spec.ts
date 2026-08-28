import type { EntityManager } from '@mikro-orm/sqlite';
import { NotFoundException } from '@packages/common';
import { describe, expect, it, vi } from 'vitest';

import { AgentKind } from '../../runs/runs.types';
import type { ChatTotalsWire, ItemWire } from '../chat.types';
import {
  CHAT_EXPORT_FORMAT_VERSION,
  ChatExportWireSchema,
} from '../chat.types';
import type { NodeStateDao } from '../dao/node-state.dao';
import type { RunDao } from '../dao/run.dao';
import type { ChatService } from './chat.service';
import { ChatExportService } from './chat-export.service';
import type { ChatMetricsService } from './chat-metrics.service';

const TOTALS: ChatTotalsWire = {
  turns: 2,
  costedTurns: 2,
  costUsd: 0.42,
  inputTokens: 100,
  outputTokens: 200,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  thinkingTokens: null,
  workedMs: 1234,
};

/**
 * A tool CALL and its RESULT, which is the pair the whole feature exists for —
 * the ask was "полностью с тул колами". Their payloads are nested objects, so a
 * projection that re-encoded them (or flattened them to a string) fails the
 * wire round-trip below rather than shipping a file nobody can read a tool call
 * out of.
 */
const ITEMS: ItemWire[] = [
  {
    id: 'i-1',
    runId: 'run-1',
    nodeId: null,
    seq: 0,
    kind: 'message',
    role: 'user',
    payload: { text: 'do the thing' },
    createdAt: '2026-08-28T10:00:00.000Z',
  },
  {
    id: 'i-2',
    runId: 'run-1',
    nodeId: null,
    seq: 1,
    kind: 'tool_call',
    role: 'assistant',
    payload: { id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } },
    createdAt: '2026-08-28T10:00:01.000Z',
  },
  {
    id: 'i-3',
    runId: 'run-1',
    nodeId: null,
    seq: 2,
    kind: 'tool_result',
    role: 'assistant',
    payload: { id: 'toolu_1', output: 'total 0\n', isError: false },
    createdAt: '2026-08-28T10:00:02.000Z',
  },
];

function build(
  opts: {
    runExists?: boolean;
    lastMetricsReading?: string | null;
    modelParameters?: string | null;
    nodes?: unknown[];
  } = {},
) {
  const getHistory = vi.fn().mockResolvedValue(ITEMS);
  const service = new ChatExportService(
    { fork: () => ({}) } as unknown as EntityManager,
    {
      getById: () =>
        Promise.resolve(
          opts.runExists === false
            ? null
            : {
                id: 'run-1',
                workflowId: null,
                status: 'completed',
                title: 'A thread',
                agentKind: AgentKind.Claude,
                cwd: '/proj',
                model: 'claude-opus-5',
                approval: 'ask',
                effort: 'high',
                contextWindow: '1m',
                modelParameters:
                  'modelParameters' in opts
                    ? opts.modelParameters
                    : '{"optimize_for":"balanced"}',
                contextTokens: 42_000,
                contextWindowTokens: 1_000_000,
                configDir: '/home/u/.claude-work',
                groupId: null,
                customInstructions: 'always answer in Russian',
                cursorMaxMode: null,
                lastMetricsReading:
                  'lastMetricsReading' in opts
                    ? opts.lastMetricsReading
                    : '{"atSeq":2,"takenAt":"2026-08-28T10:00:03.000Z"}',
                pendingContext: null,
                createdAt: new Date('2026-08-28T09:00:00.000Z'),
                updatedAt: new Date('2026-08-28T10:00:02.000Z'),
              },
        ),
    } as unknown as RunDao,
    {
      listByRun: () =>
        Promise.resolve(
          opts.nodes ?? [
            {
              nodeId: 'agent',
              status: 'completed',
              agentKind: AgentKind.Claude,
              model: 'claude-opus-5',
              agentSessionId: 'sess-1',
              startedAt: 1,
              endedAt: 2,
              error: null,
            },
          ],
        ),
    } as unknown as NodeStateDao,
    { getHistory } as unknown as ChatService,
    {
      readTotals: () => Promise.resolve(TOTALS),
    } as unknown as ChatMetricsService,
  );
  return { service, getHistory };
}

describe('ChatExportService', () => {
  it('exports a document the wire schema accepts, with the whole transcript', async () => {
    const { service } = build();

    const doc = await service.export('run-1');

    // The SCHEMA is the assertion, not a hand-listed field set: it is what the
    // route serializes through, so a shape this parses is a shape the daemon
    // will actually serve.
    expect(() => ChatExportWireSchema.parse(doc)).not.toThrow();
    expect(doc.formatVersion).toBe(CHAT_EXPORT_FORMAT_VERSION);
    expect(doc.items).toHaveLength(3);
    expect(doc.totals).toEqual(TOTALS);
    expect(doc.nodes[0]?.agentSessionId).toBe('sess-1');
  });

  it('asks for the transcript UNWINDOWED', async () => {
    const { service, getHistory } = build();

    await service.export('run-1');

    // The page-size argument being absent is the whole guarantee: passing one
    // would export the window a screen holds and say nothing about the rest.
    expect(getHistory).toHaveBeenCalledWith('run-1');
  });

  it('keeps a tool call and its result verbatim, payloads structured', async () => {
    const { service } = build();

    const doc = await service.export('run-1');

    const call = doc.items.find((item) => item.kind === 'tool_call');
    const result = doc.items.find((item) => item.kind === 'tool_result');
    expect(call?.payload).toEqual({
      id: 'toolu_1',
      name: 'Bash',
      input: { command: 'ls -la' },
    });
    expect(result?.payload).toEqual({
      id: 'toolu_1',
      output: 'total 0\n',
      isError: false,
    });
  });

  it('carries the run fields the chat wire has never exposed', async () => {
    const { service } = build();

    const doc = await service.export('run-1');

    // The four `RunWireSchema` withholds — what the turns actually ran under.
    expect(doc.run.customInstructions).toBe('always answer in Russian');
    expect(doc.run.cursorMaxMode).toBeNull();
    expect(doc.run.pendingContext).toBeNull();
    expect(doc.run.lastMetricsReading).toEqual({
      atSeq: 2,
      takenAt: '2026-08-28T10:00:03.000Z',
    });
    expect(doc.run.modelParameters).toEqual({ optimize_for: 'balanced' });
  });

  it('reports an unreadable stored reading as absent rather than failing', async () => {
    const { service } = build({ lastMetricsReading: 'not json{' });

    const doc = await service.export('run-1');

    // The defensive branch, entered: a column that cannot be parsed must cost
    // the user that one field, never the export of the conversation around it.
    expect(doc.run.lastMetricsReading).toBeNull();
    expect(doc.items).toHaveLength(3);
  });

  it('404s on a run that does not exist', async () => {
    const { service } = build({ runExists: false });

    await expect(service.export('nope')).rejects.toThrow(NotFoundException);
  });
});

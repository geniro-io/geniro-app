import { afterEach, describe, expect, it, vi } from 'vitest';

import { HISTORY_RESULT_PREFACE } from '../../../agents/chat.types';
import { AnalysisBroker } from '../../../agents/services/analysis.broker';
import {
  PAGE_BYTES,
  type ThreadReaderService,
} from '../../../agents/services/thread-reader.service';
import {
  clearSecrets,
  registerSecret,
} from '../../../diagnostics/utils/redact';
import type { WorkflowChangeService } from '../../../graphs/services/workflow-change.service';
import type { WorkflowHistoryService } from '../../../stats/services/workflow-history.service';
import type { McpCallContext } from '../../mcp.types';
import {
  analyzedThreadResultText,
  readAnalyzedThreadArgs,
} from './read-analyzed-thread.reader';
import { ReadAnalyzedThreadTool } from './read-analyzed-thread.tool';

const CONTEXT = {
  runId: 'analysis',
  nodeId: 'agent',
  conversationId: null,
  caller: 'agent',
  requestId: 1,
} as McpCallContext;

function tool(
  reader: Partial<ThreadReaderService>,
  workflows: Partial<WorkflowChangeService> = {},
  installed = true,
  history: Partial<WorkflowHistoryService> = {},
  workflowRuns: string[] | null = null,
) {
  const analysis = new AnalysisBroker();
  if (installed) {
    analysis.register('analysis', 'agent', {
      turn: {
        analysisRunId: 'analysis',
        sourceRunId: 'source',
        snapshotSeq: 9,
        sourceWorking: true,
        ...(workflowRuns === null
          ? {}
          : {
              workflow: {
                slug: 'dev-team',
                runs: workflowRuns.map((runId) => ({
                  runId,
                  snapshotSeq: 9,
                  working: false,
                })),
              },
            }),
      },
      report: () => Promise.reject(new Error('unused')),
      mark: () => Promise.reject(new Error('unused')),
    });
  }
  return new ReadAnalyzedThreadTool(
    analysis,
    reader as ThreadReaderService,
    workflows as WorkflowChangeService,
    history as WorkflowHistoryService,
  );
}

function textOf(result: { content: { text: string }[] }): string {
  return result.content[0]!.text;
}

afterEach(() => {
  clearSecrets();
});

describe('readAnalyzedThreadArgs', () => {
  it('refuses an unknown view and a misspelt field rather than widening the read', () => {
    expect(readAnalyzedThreadArgs({ view: 'everything' }).ok).toBe(false);
    expect(readAnalyzedThreadArgs({ view: 'items', after_seq: 4 }).ok).toBe(
      false,
    );
    expect(readAnalyzedThreadArgs({ view: 'items', afterSeq: null })).toEqual({
      ok: true,
      query: { view: 'items' },
    });
  });
});

describe('ReadAnalyzedThreadTool', () => {
  it('reads only the source the broker scoped it to, up to the snapshot', async () => {
    const asked: unknown[] = [];
    const result = await tool({
      read: (source, query) => {
        asked.push({ source, query });
        return Promise.resolve({ items: [] });
      },
    }).call('read_analyzed_thread', { view: 'items' }, CONTEXT);

    expect(asked).toEqual([
      {
        source: {
          analysisRunId: 'analysis',
          sourceRunId: 'source',
          snapshotSeq: 9,
          sourceWorking: true,
        },
        query: { view: 'items' },
      },
    ]);
    expect(textOf(result).startsWith(HISTORY_RESULT_PREFACE)).toBe(true);
  });

  it('masks a registered secret anywhere in the page', async () => {
    registerSecret('ghp_0123456789abcdefghij', 'github token');

    const result = await tool({
      read: () =>
        Promise.resolve({ text: 'pushed with ghp_0123456789abcdefghij' }),
    }).call('read_analyzed_thread', { view: 'item', seq: 1 }, CONTEXT);

    expect(textOf(result)).not.toContain('ghp_0123456789abcdefghij');
  });

  it('answers the workflow view with the hash and diff, paged when it is long', async () => {
    const roles = 'r'.repeat(PAGE_BYTES * 2);
    const workflows = {
      describe: (slug: string) =>
        Promise.resolve({
          slug,
          hash: 'abc123',
          workflow: { name: 'Dev Team', role: roles },
          changedSinceThisRun: { identical: true },
        }),
    };
    const reader = {
      analysedWorkflowOf: () =>
        Promise.resolve({
          slug: 'dev-team',
          snapshot: null,
          instructions: null,
        }),
    };

    const first = textOf(
      await tool(reader, workflows).call(
        'read_analyzed_thread',
        { view: 'workflow' },
        CONTEXT,
      ),
    );

    expect(Buffer.byteLength(first)).toBeLessThanOrEqual(PAGE_BYTES + 200);
    const page = JSON.parse(first.slice(first.indexOf('\n') + 1)) as {
      text: string;
      next: { offset: number };
    };
    expect(page.text).toContain('"hash":"abc123"');
    expect(page.next.offset).toBeGreaterThan(0);
  });

  it("measures the workflow view's instructions with what the run itself was composed with", async () => {
    const instructions = {
      customInstructions: 'MINE',
      replyLanguage: 'Russian',
      taskInstructions: 'CARD',
      memoryIndex: 'INDEX',
    };
    const describeWorkflow = vi.fn<WorkflowChangeService['describe']>(() =>
      Promise.resolve({ slug: 'dev-team' }),
    );

    await tool(
      {
        analysedWorkflowOf: () =>
          Promise.resolve({
            slug: 'dev-team',
            snapshot: 'name: Team',
            instructions,
          }),
      },
      { describe: describeWorkflow },
    ).call('read_analyzed_thread', { view: 'workflow' }, CONTEXT);

    expect(describeWorkflow).toHaveBeenCalledWith(
      'dev-team',
      'name: Team',
      instructions,
    );
  });

  it('tells a plain chat analysis there is no workflow', async () => {
    const result = await tool({
      analysedWorkflowOf: () => Promise.resolve(null),
    }).call('read_analyzed_thread', { view: 'workflow' }, CONTEXT);

    expect(textOf(result)).toContain('NOT_A_WORKFLOW');
  });

  it('refuses a workflow view of a run the analysis does not read, reading nothing', async () => {
    const analysedWorkflowOf = vi.fn(() =>
      Promise.resolve({ slug: 'dev-team', snapshot: null, instructions: null }),
    );

    const result = await tool({ analysedWorkflowOf }).call(
      'read_analyzed_thread',
      { view: 'workflow', runId: 'other-run' },
      CONTEXT,
    );

    expect(textOf(result)).toContain('NOT_ANALYSED');
    expect(analysedWorkflowOf).not.toHaveBeenCalled();
  });

  it("answers the history view from the workflow's ledgers, scoped to the analysis's runs and naming its own chat", async () => {
    registerSecret('ghp_0123456789abcdefghij', 'github token');
    const read = vi.fn<WorkflowHistoryService['read']>(() =>
      Promise.resolve({
        workflow: 'dev-team',
        changeLog: [
          { reason: 'ghp_0123456789abcdefghij'.padEnd(PAGE_BYTES * 2, 'x') },
        ],
      } as unknown as Awaited<ReturnType<WorkflowHistoryService['read']>>),
    );
    const reading = tool(
      {
        analysedWorkflowOf: () =>
          Promise.resolve({
            slug: 'dev-team',
            snapshot: null,
            instructions: null,
          }),
      },
      {},
      true,
      { read },
      ['newest', 'older'],
    );

    const first = textOf(
      await reading.call('read_analyzed_thread', { view: 'history' }, CONTEXT),
    );

    expect(read).toHaveBeenCalledWith('dev-team', {
      analysedRunIds: ['newest', 'older'],
      readerRunId: 'analysis',
    });
    expect(first.startsWith(HISTORY_RESULT_PREFACE)).toBe(true);
    expect(first).not.toContain('ghp_0123456789abcdefghij');
    expect(Buffer.byteLength(first)).toBeLessThanOrEqual(PAGE_BYTES + 200);
    const page = JSON.parse(first.slice(first.indexOf('\n') + 1)) as {
      next: { offset: number };
    };
    expect(page.next.offset).toBeGreaterThan(0);
  });

  it("scopes a workflow thread's history to the one thread it analyses", async () => {
    const read = vi.fn<WorkflowHistoryService['read']>(() =>
      Promise.resolve({ workflow: 'dev-team' } as unknown as Awaited<
        ReturnType<WorkflowHistoryService['read']>
      >),
    );

    await tool(
      {
        analysedWorkflowOf: () =>
          Promise.resolve({
            slug: 'dev-team',
            snapshot: null,
            instructions: null,
          }),
      },
      {},
      true,
      { read },
    ).call('read_analyzed_thread', { view: 'history' }, CONTEXT);

    expect(read).toHaveBeenCalledWith('dev-team', {
      analysedRunIds: ['source'],
      readerRunId: 'analysis',
    });
  });

  it('tells a plain chat analysis it has no workflow history, reading none', async () => {
    const read = vi.fn<WorkflowHistoryService['read']>();

    const result = await tool(
      { analysedWorkflowOf: () => Promise.resolve(null) },
      {},
      true,
      { read },
    ).call('read_analyzed_thread', { view: 'history' }, CONTEXT);

    expect(textOf(result)).toContain('NOT_A_WORKFLOW');
    expect(read).not.toHaveBeenCalled();
  });

  it("hands the reader the workflow's version numbers, so view=runs names each run's version", async () => {
    const index = { current: 'v2', numbers: new Map([['v2', 2]]) };
    const versionIndex = vi.fn(() => Promise.resolve(index));
    let handed: unknown = null;

    await tool(
      {
        read: async (_turn, _query, versions) => {
          handed = await versions?.('dev-team');
          return {};
        },
      },
      {},
      true,
      { versionIndex },
      ['newest'],
    ).call('read_analyzed_thread', { view: 'runs' }, CONTEXT);

    expect(versionIndex).toHaveBeenCalledWith('dev-team');
    expect(handed).toBe(index);
  });

  it('is not offered, and reads nothing, without an analysis turn', async () => {
    const reading = tool({}, {}, false);

    expect(
      reading.list({
        runId: 'analysis',
        nodeId: 'agent',
        conversationId: null,
      }),
    ).toEqual([]);
    const result = await reading.call(
      'read_analyzed_thread',
      { view: 'overview' },
      CONTEXT,
    );
    expect(result.isError).toBe(true);
  });

  it('puts the data line in front of every answer', () => {
    expect(analyzedThreadResultText({ a: 1 })).toBe(
      `${HISTORY_RESULT_PREFACE}\n{"a":1}`,
    );
  });
});

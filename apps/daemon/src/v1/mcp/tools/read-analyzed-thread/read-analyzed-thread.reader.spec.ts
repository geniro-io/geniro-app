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
import type { TeamHistoryService } from '../../../stats/services/team-history.service';
import type { TeamChangeService } from '../../../teams/services/team-change.service';
import type { McpCallContext } from '../../mcp.types';
import {
  analyzedThreadResultText,
  readAnalyzedThreadArgs,
} from './read-analyzed-thread.reader';
import { ReadAnalyzedThreadTool } from './read-analyzed-thread.tool';

const CONTEXT = {
  runId: 'analysis',
  memberId: 'agent',
  conversationId: null,
  caller: 'agent',
  requestId: 1,
} as McpCallContext;

function tool(
  reader: Partial<ThreadReaderService>,
  teams: Partial<TeamChangeService> = {},
  installed = true,
  history: Partial<TeamHistoryService> = {},
  teamRuns: string[] | null = null,
) {
  const analysis = new AnalysisBroker();
  if (installed) {
    analysis.register('analysis', 'agent', {
      turn: {
        analysisRunId: 'analysis',
        sourceRunId: 'source',
        snapshotSeq: 9,
        sourceWorking: true,
        ...(teamRuns === null
          ? {}
          : {
              team: {
                slug: 'dev-team',
                runs: teamRuns.map((runId) => ({
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
    teams as TeamChangeService,
    history as TeamHistoryService,
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

  it('answers the team view with the hash and diff, paged when it is long', async () => {
    const roles = 'r'.repeat(PAGE_BYTES * 2);
    const teams = {
      describe: (slug: string) =>
        Promise.resolve({
          slug,
          hash: 'abc123',
          team: { name: 'Dev Team', role: roles },
          changedSinceThisRun: { identical: true },
        }),
    };
    const reader = {
      analysedTeamOf: () =>
        Promise.resolve({
          slug: 'dev-team',
          snapshot: null,
          instructions: null,
        }),
    };

    const first = textOf(
      await tool(reader, teams).call(
        'read_analyzed_thread',
        { view: 'team' },
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

  it("measures the team view's instructions with what the run itself was composed with", async () => {
    const instructions = {
      customInstructions: 'MINE',
      projectInstructions: 'PROJECT',
      replyLanguage: 'Russian',
      taskInstructions: 'CARD',
      memoryIndex: 'INDEX',
    };
    const describeTeam = vi.fn<TeamChangeService['describe']>(() =>
      Promise.resolve({ slug: 'dev-team' }),
    );

    await tool(
      {
        analysedTeamOf: () =>
          Promise.resolve({
            slug: 'dev-team',
            snapshot: 'name: Team',
            instructions,
          }),
      },
      { describe: describeTeam },
    ).call('read_analyzed_thread', { view: 'team' }, CONTEXT);

    expect(describeTeam).toHaveBeenCalledWith(
      'dev-team',
      'name: Team',
      instructions,
    );
  });

  it('tells a plain chat analysis there is no team', async () => {
    const result = await tool({
      analysedTeamOf: () => Promise.resolve(null),
    }).call('read_analyzed_thread', { view: 'team' }, CONTEXT);

    expect(textOf(result)).toContain('NOT_A_TEAM');
  });

  it('refuses a team view of a run the analysis does not read, reading nothing', async () => {
    const analysedTeamOf = vi.fn(() =>
      Promise.resolve({ slug: 'dev-team', snapshot: null, instructions: null }),
    );

    const result = await tool({ analysedTeamOf }).call(
      'read_analyzed_thread',
      { view: 'team', runId: 'other-run' },
      CONTEXT,
    );

    expect(textOf(result)).toContain('NOT_ANALYSED');
    expect(analysedTeamOf).not.toHaveBeenCalled();
  });

  it("answers the history view from the team's ledgers, scoped to the analysis's runs and naming its own chat", async () => {
    registerSecret('ghp_0123456789abcdefghij', 'github token');
    const read = vi.fn<TeamHistoryService['read']>(() =>
      Promise.resolve({
        team: 'dev-team',
        changeLog: [
          { reason: 'ghp_0123456789abcdefghij'.padEnd(PAGE_BYTES * 2, 'x') },
        ],
      } as unknown as Awaited<ReturnType<TeamHistoryService['read']>>),
    );
    const reading = tool(
      {
        analysedTeamOf: () =>
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

  it("scopes a team thread's history to the one thread it analyses", async () => {
    const read = vi.fn<TeamHistoryService['read']>(() =>
      Promise.resolve({ team: 'dev-team' } as unknown as Awaited<
        ReturnType<TeamHistoryService['read']>
      >),
    );

    await tool(
      {
        analysedTeamOf: () =>
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

  it('tells a plain chat analysis it has no team history, reading none', async () => {
    const read = vi.fn<TeamHistoryService['read']>();

    const result = await tool(
      { analysedTeamOf: () => Promise.resolve(null) },
      {},
      true,
      { read },
    ).call('read_analyzed_thread', { view: 'history' }, CONTEXT);

    expect(textOf(result)).toContain('NOT_A_TEAM');
    expect(read).not.toHaveBeenCalled();
  });

  it("hands the reader the team's version numbers, so view=runs names each run's version", async () => {
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
        memberId: 'agent',
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

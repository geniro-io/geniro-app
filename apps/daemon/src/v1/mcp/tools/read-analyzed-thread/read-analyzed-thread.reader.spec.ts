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

const SECRET = 'ghp_0123456789abcdefghij';

const TEAM = {
  slug: 'dev-team',
  snapshot: null,
  baseSnapshot: null,
  overlaySnapshot: null,
  instructions: null,
};

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

function historyReader(history: unknown, runIds: string[] | null = ['newest']) {
  return tool(
    { analysedTeamOf: () => Promise.resolve(TEAM) },
    {},
    true,
    {
      read: () =>
        Promise.resolve(
          history as Awaited<ReturnType<TeamHistoryService['read']>>,
        ),
    },
    runIds,
  );
}

function textOf(result: { content: { text: string }[] }): string {
  return result.content[0]!.text;
}

function pageOf(text: string): Record<string, unknown> {
  return JSON.parse(text.slice(text.indexOf('\n') + 1)) as Record<
    string,
    unknown
  >;
}

function longHistory(count: number): Record<string, unknown> {
  return {
    team: 'dev-team',
    summary: { runs: 1 },
    versions: Array.from({ length: count }, (_, index) => ({
      version: {
        version: `hash-${index + 1}`,
        number: index + 1,
        current: index + 1 === count,
      },
      changes: {
        added: 1,
        removed: 0,
        diff: `+ line ${index}\n`.repeat(20),
      },
      note: index === 7 ? `token ${SECRET} in the note` : 'n'.repeat(2_000),
    })),
    changeLog: [],
    recommendations: [],
    members: [],
  };
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

  it('accepts a history section with its version and part, and refuses a section it does not name', () => {
    expect(
      readAnalyzedThreadArgs({
        view: 'history',
        section: 'diff',
        version: 2,
        part: 0,
      }),
    ).toEqual({
      ok: true,
      query: { view: 'history', section: 'diff', version: 2, part: 0 },
    });
    expect(
      readAnalyzedThreadArgs({
        view: 'history',
        section: 'diff',
        version: 'hash-2',
      }).ok,
    ).toBe(true);
    expect(
      readAnalyzedThreadArgs({ view: 'history', section: 'everything' }).ok,
    ).toBe(false);
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
    registerSecret(SECRET, 'github token');

    const result = await tool({
      read: () => Promise.resolve({ text: `pushed with ${SECRET}` }),
    }).call('read_analyzed_thread', { view: 'item', seq: 1 }, CONTEXT);

    expect(textOf(result)).not.toContain(SECRET);
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
      analysedTeamOf: () => Promise.resolve(TEAM),
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
      knowledgeIndex: 'DOCS',
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
            baseSnapshot: 'name: Base',
            overlaySnapshot: null,
            instructions,
          }),
      },
      { describe: describeTeam },
    ).call('read_analyzed_thread', { view: 'team' }, CONTEXT);

    expect(describeTeam).toHaveBeenCalledWith(
      'dev-team',
      'name: Team',
      instructions,
      'name: Base',
      { snapshot: null, projectId: null },
    );
  });

  it('tells a plain chat analysis there is no team', async () => {
    const result = await tool({
      analysedTeamOf: () => Promise.resolve(null),
    }).call('read_analyzed_thread', { view: 'team' }, CONTEXT);

    expect(textOf(result)).toContain('NOT_A_TEAM');
  });

  it('refuses a team view of a run the analysis does not read, reading nothing', async () => {
    const analysedTeamOf = vi.fn(() => Promise.resolve(TEAM));

    const result = await tool({ analysedTeamOf }).call(
      'read_analyzed_thread',
      { view: 'team', runId: 'other-run' },
      CONTEXT,
    );

    expect(textOf(result)).toContain('NOT_ANALYSED');
    expect(analysedTeamOf).not.toHaveBeenCalled();
  });

  it("answers a bare history view with the summary, not the records, scoped to the analysis's runs and naming its own chat", async () => {
    registerSecret(SECRET, 'github token');
    const read = vi.fn<TeamHistoryService['read']>(() =>
      Promise.resolve({
        team: 'dev-team',
        changeLog: [{ reason: `${SECRET}`.padEnd(PAGE_BYTES * 2, 'x') }],
      } as unknown as Awaited<ReturnType<TeamHistoryService['read']>>),
    );
    const reading = tool(
      { analysedTeamOf: () => Promise.resolve(TEAM) },
      {},
      true,
      { read },
      ['newest', 'older'],
    );

    const bare = textOf(
      await reading.call('read_analyzed_thread', { view: 'history' }, CONTEXT),
    );

    expect(read).toHaveBeenCalledWith('dev-team', {
      analysedRunIds: ['newest', 'older'],
      readerRunId: 'analysis',
    });
    expect(bare.startsWith(HISTORY_RESULT_PREFACE)).toBe(true);
    expect(bare).not.toContain(SECRET);
    expect(bare).not.toContain('x'.repeat(1_000));
    expect(Buffer.byteLength(bare)).toBeLessThanOrEqual(PAGE_BYTES + 200);
    const summary = pageOf(bare);
    expect(summary.sections).toMatchObject({ changeLog: { records: 1 } });
    expect(
      (summary.sections as { changeLog: { bytes: number } }).changeLog.bytes,
    ).toBeGreaterThan(PAGE_BYTES);
    expect(summary.next).toEqual({ section: 'versions', offset: 0 });
  });

  it('answers a history offset with the old chunk of the whole answer, and a history that fits one page whole', async () => {
    const reading = historyReader({
      team: 'dev-team',
      changeLog: [{ reason: 'x'.repeat(PAGE_BYTES * 2) }],
    });

    const chunk = pageOf(
      textOf(
        await reading.call(
          'read_analyzed_thread',
          { view: 'history', offset: 1 },
          CONTEXT,
        ),
      ),
    );
    expect(chunk.offset).toBe(1);
    expect(chunk.text).toMatch(/^"team":"dev-team"/);

    const whole = pageOf(
      textOf(
        await historyReader({ team: 'dev-team', changeLog: [] }).call(
          'read_analyzed_thread',
          { view: 'history' },
          CONTEXT,
        ),
      ),
    );
    expect(whole).toEqual({ team: 'dev-team', changeLog: [] });
  });

  it('answers a long history section by section, each page parsing alone within a page, every record once and in order, masked', async () => {
    registerSecret(SECRET, 'github token');
    const reading = historyReader(longHistory(40));

    const bare = pageOf(
      textOf(
        await reading.call(
          'read_analyzed_thread',
          { view: 'history' },
          CONTEXT,
        ),
      ),
    );
    expect(bare.sections).toMatchObject({
      versions: { records: 40 },
      diffs: { versions: 40 },
    });

    const records: Record<string, unknown>[] = [];
    let pages = 0;
    let query: Record<string, unknown> | null = {
      view: 'history',
      section: 'versions',
      offset: 0,
    };
    for (let guard = 0; query !== null && guard < 100; guard += 1) {
      const text = textOf(
        await reading.call('read_analyzed_thread', query, CONTEXT),
      );
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(PAGE_BYTES + 200);
      const page = pageOf(text);
      pages += 1;
      records.push(...(page.records as Record<string, unknown>[]));
      query =
        page.next === null
          ? null
          : { view: 'history', ...(page.next as Record<string, unknown>) };
    }

    expect(pages).toBeGreaterThan(1);
    expect(
      records.map((record) => (record.version as { number: number }).number),
    ).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(records[0]!.changes).toEqual({ added: 1, removed: 0 });
  });

  it('answers a record longer than a page in parts that join back to it, and the page after continues at the next record', async () => {
    const big = {
      version: { version: 'hash-2', number: 2, current: false },
      note: 'b'.repeat(PAGE_BYTES * 2),
    };
    const reading = historyReader({
      team: 'dev-team',
      versions: [
        {
          version: { version: 'hash-1', number: 1, current: false },
          note: 'a',
        },
        big,
        { version: { version: 'hash-3', number: 3, current: true }, note: 'c' },
      ],
      changeLog: [],
      recommendations: [],
      members: [],
    });

    const first = pageOf(
      textOf(
        await reading.call(
          'read_analyzed_thread',
          { view: 'history', section: 'versions', offset: 0 },
          CONTEXT,
        ),
      ),
    );
    expect(first.records).toHaveLength(1);
    expect(first.next).toEqual({ section: 'versions', offset: 1 });

    const texts: string[] = [];
    let after: unknown = null;
    let query: Record<string, unknown> | null = {
      view: 'history',
      section: 'versions',
      offset: 1,
      part: 0,
    };
    while (query !== null) {
      const page = pageOf(
        textOf(await reading.call('read_analyzed_thread', query, CONTEXT)),
      );
      texts.push(page.text as string);
      const next = page.next as {
        section: string;
        offset: number;
        part?: number;
      } | null;
      if (next === null) {
        break;
      }
      if (next.part === undefined) {
        after = next;
        break;
      }
      query = { view: 'history', ...next };
    }

    expect(texts.length).toBeGreaterThan(1);
    expect(JSON.parse(texts.join(''))).toEqual(big);
    expect(after).toEqual({ section: 'versions', offset: 2 });

    const last = pageOf(
      textOf(
        await reading.call(
          'read_analyzed_thread',
          { view: 'history', section: 'versions', offset: 2 },
          CONTEXT,
        ),
      ),
    );
    expect(last.records).toEqual([
      { version: { version: 'hash-3', number: 3, current: true }, note: 'c' },
    ]);
    expect(last.next).toBeNull();
  });

  it('answers a version diff by its number or its hash, and cuts a long diff on line breaks so the pages join back to it', async () => {
    const diff = `${Array.from({ length: 1_000 }, (_, index) => `line ${index} ${'d'.repeat(70)}`).join('\n')}\n`;
    const reading = historyReader({
      team: 'dev-team',
      versions: [
        {
          version: { version: 'hash-1', number: 1, current: false },
          changes: { added: 3, removed: 1, diff: 'small diff\n' },
        },
        {
          version: { version: 'hash-2', number: 2, current: false },
          changes: { added: 1_000, removed: 0, diff },
        },
        {
          version: { version: 'hash-3', number: 3, current: true },
          changes: null,
        },
        {
          version: { version: 'hash-4', number: 4, current: true },
          changes: { added: 1, removed: 1, diff: 'z'.repeat(PAGE_BYTES * 2) },
        },
      ],
      changeLog: [],
      recommendations: [],
      members: [],
    });
    const diffQuery = (version: number | string, offset = 0) => ({
      view: 'history',
      section: 'diff',
      version,
      offset,
    });

    const byNumber = pageOf(
      textOf(await reading.call('read_analyzed_thread', diffQuery(1), CONTEXT)),
    );
    const byHash = pageOf(
      textOf(
        await reading.call(
          'read_analyzed_thread',
          diffQuery('hash-1'),
          CONTEXT,
        ),
      ),
    );
    expect(byNumber).toMatchObject({
      version: { version: 'hash-1', number: 1, current: false },
      added: 3,
      removed: 1,
      text: 'small diff\n',
      next: null,
    });
    expect(byHash).toEqual(byNumber);

    const texts: string[] = [];
    let query: Record<string, unknown> | null = diffQuery(2);
    for (let guard = 0; query !== null && guard < 100; guard += 1) {
      const text = textOf(
        await reading.call('read_analyzed_thread', query, CONTEXT),
      );
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(PAGE_BYTES + 200);
      const page = pageOf(text);
      texts.push(page.text as string);
      query =
        page.next === null
          ? null
          : { view: 'history', ...(page.next as Record<string, unknown>) };
      if (query !== null) {
        expect((page.text as string).endsWith('\n')).toBe(true);
      }
    }
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.join('')).toBe(diff);

    expect(
      pageOf(
        textOf(
          await reading.call(
            'read_analyzed_thread',
            { view: 'history', section: 'diff' },
            CONTEXT,
          ),
        ),
      ).error,
    ).toBe('INVALID_ARGS');
    expect(
      pageOf(
        textOf(
          await reading.call('read_analyzed_thread', diffQuery(99), CONTEXT),
        ),
      ).error,
    ).toBe('UNKNOWN_VERSION');

    const noDiff = pageOf(
      textOf(await reading.call('read_analyzed_thread', diffQuery(3), CONTEXT)),
    );
    expect(noDiff.next).toBeNull();
    expect(typeof noDiff.note).toBe('string');
    expect(noDiff.text).toBeUndefined();

    const oneLine: string[] = [];
    let line: Record<string, unknown> | null = diffQuery(4);
    for (let guard = 0; line !== null && guard < 100; guard += 1) {
      const page = pageOf(
        textOf(await reading.call('read_analyzed_thread', line, CONTEXT)),
      );
      oneLine.push(page.text as string);
      line =
        page.next === null
          ? null
          : { view: 'history', ...(page.next as Record<string, unknown>) };
    }
    expect(oneLine.length).toBeGreaterThan(1);
    expect(oneLine.join('')).toBe('z'.repeat(PAGE_BYTES * 2));
  });

  it("answers the spend view from the team's ledgers over the analysis's runs, masked", async () => {
    registerSecret(SECRET, 'github token');
    const spend = vi.fn<TeamHistoryService['spend']>(() =>
      Promise.resolve({
        team: 'dev-team',
        note: `pushed with ${SECRET}`,
      } as unknown as Awaited<ReturnType<TeamHistoryService['spend']>>),
    );

    const result = await tool(
      { analysedTeamOf: () => Promise.resolve(TEAM) },
      {},
      true,
      { spend },
      ['newest', 'older'],
    ).call('read_analyzed_thread', { view: 'spend' }, CONTEXT);

    expect(spend).toHaveBeenCalledWith('dev-team', {
      analysedRunIds: ['newest', 'older'],
    });
    expect(textOf(result)).not.toContain(SECRET);
    expect(pageOf(textOf(result))).toMatchObject({ team: 'dev-team' });
  });

  it("scopes a team thread's spend to the one thread it analyses", async () => {
    const spend = vi.fn<TeamHistoryService['spend']>(() =>
      Promise.resolve({ team: 'dev-team' } as unknown as Awaited<
        ReturnType<TeamHistoryService['spend']>
      >),
    );

    await tool({ analysedTeamOf: () => Promise.resolve(TEAM) }, {}, true, {
      spend,
    }).call('read_analyzed_thread', { view: 'spend' }, CONTEXT);

    expect(spend).toHaveBeenCalledWith('dev-team', {
      analysedRunIds: ['source'],
    });
  });

  it('tells a plain chat analysis it has no team spend, reading none', async () => {
    const spend = vi.fn<TeamHistoryService['spend']>();

    const result = await tool(
      { analysedTeamOf: () => Promise.resolve(null) },
      {},
      true,
      { spend },
    ).call('read_analyzed_thread', { view: 'spend' }, CONTEXT);

    expect(textOf(result)).toContain('NOT_A_TEAM');
    expect(spend).not.toHaveBeenCalled();
  });

  it('scopes a team thread’s history to the one thread it analyses', async () => {
    const read = vi.fn<TeamHistoryService['read']>(() =>
      Promise.resolve({ team: 'dev-team' } as unknown as Awaited<
        ReturnType<TeamHistoryService['read']>
      >),
    );

    await tool(
      {
        analysedTeamOf: () => Promise.resolve(TEAM),
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

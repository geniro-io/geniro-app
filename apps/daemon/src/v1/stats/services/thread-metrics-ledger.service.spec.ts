import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hostMcpServerName } from '../../agents/utils/host-question';
import { Run } from '../../runs/entity/run.entity';
import type { AgentKind } from '../../runs/runs.types';
import { metricLedgerDb } from '../__tests__/metric-ledger-db';

type Db = Awaited<ReturnType<typeof metricLedgerDb>>;

const RUN = 'run-00000001';

describe('ThreadMetricsLedgerService — tool calls', () => {
  let db: Db;

  beforeEach(async () => {
    db = await metricLedgerDb();
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  const cases: {
    agent: AgentKind;
    mcpName: string;
    ownName: string;
    ownKind: string | null;
    ownTool: string;
  }[] = [
    {
      agent: 'claude',
      mcpName: 'mcp__codegraph__codegraph_explore',
      ownName: 'Bash',
      ownKind: null,
      ownTool: 'Bash',
    },
    {
      agent: 'codex',
      mcpName: 'mcp__codegraph__codegraph_explore',
      ownName: 'shell',
      ownKind: 'execute',
      ownTool: 'shell',
    },
    {
      agent: 'cursor-agent',
      mcpName: 'codegraph-codegraph_explore: codegraph_explore',
      ownName: '`pnpm test`',
      ownKind: 'execute',
      ownTool: 'execute',
    },
  ];

  for (const { agent, mcpName, ownName, ownKind, ownTool } of cases) {
    it(`writes one row per finished tool call with its MCP server (${agent})`, async () => {
      await db.seedRun(RUN, { teamId: 'dev-team' });
      await db.seedMember(RUN, 'dev', agent);
      await db.feed(
        RUN,
        'tool_call',
        { id: 't1', name: mcpName },
        '2026-11-01T10:00:00.000Z',
        'dev',
      );
      await db.feed(
        RUN,
        'tool_call',
        {
          id: 't2',
          name: ownName,
          ...(ownKind === null ? {} : { toolKind: ownKind }),
        },
        '2026-11-01T10:00:01.000Z',
        'dev',
      );
      await db.feed(
        RUN,
        'tool_result',
        { id: 't1', name: null, isError: false },
        '2026-11-01T10:00:02.500Z',
        'dev',
      );
      const failed = await db.feed(
        RUN,
        'tool_result',
        { id: 't2', name: null, isError: true },
        '2026-11-01T10:00:03.000Z',
        'dev',
      );
      await db.service.observe({ runId: RUN, item: failed });

      const rows = await db.ledger.toolCalls({ teamSlug: 'dev-team' });
      expect(
        rows.map((row) => [row.tool, row.mcpServer, row.ok, row.durationMs]),
      ).toEqual([
        ['codegraph_explore', 'codegraph', true, 2500],
        [ownTool, null, false, 2000],
      ]);
      expect(rows[0]).toMatchObject({ memberId: 'dev', agentKind: agent });
    });
  }

  it('reads a pool member on another CLI by its own spelling, and never keeps a command as a tool', async () => {
    await db.seedRun(RUN, { teamId: 'dev-team' });
    await db.seedMember(RUN, 'dev', 'claude');
    const call = async (id: string, name: string, toolKind?: string) => {
      await db.feed(
        RUN,
        'tool_call',
        { id, name, ...(toolKind === undefined ? {} : { toolKind }) },
        '2026-11-01T10:00:00.000Z',
        'dev',
      );
      await db.feed(
        RUN,
        'tool_result',
        { id, isError: false },
        '2026-11-01T10:00:01.000Z',
        'dev',
      );
    };
    await call('c1', 'codegraph-codegraph_explore: codegraph_explore', 'other');
    await call(
      'c2',
      '`curl -H "Authorization: Bearer abc" https://x.test`',
      'execute',
    );
    await call('c3', 'src/app.ts');

    expect(
      (await db.ledger.toolCalls({})).map((row) => [row.tool, row.mcpServer]),
    ).toEqual([
      ['codegraph_explore', 'codegraph'],
      ['execute', null],
      ['other', null],
    ]);
  });

  it('pairs a result with the call of its own conversation when an id repeats', async () => {
    await db.seedRun(RUN, { teamId: 'dev-team' });
    await db.seedMember(RUN, 'dev', 'claude');
    await db.feed(
      RUN,
      'tool_call',
      { id: '1', name: 'Read' },
      '2026-11-01T10:00:00.000Z',
      'dev',
    );
    await db.feed(
      RUN,
      'tool_call',
      { id: '1', name: 'Bash' },
      '2026-11-01T10:00:05.000Z',
      'dev',
      'call-1',
    );
    await db.feed(
      RUN,
      'tool_result',
      { id: '1', isError: false },
      '2026-11-01T10:00:06.000Z',
      'dev',
    );
    await db.feed(
      RUN,
      'tool_result',
      { id: '1', isError: false },
      '2026-11-01T10:00:07.000Z',
      'dev',
      'call-1',
    );

    expect(
      (await db.ledger.toolCalls({})).map((row) => [row.tool, row.durationMs]),
    ).toEqual([
      ['Read', 6_000],
      ['Bash', 2_000],
    ]);
  });

  it("names this app's own server geniro, and pairs a result whose call came before the process saw it", async () => {
    await db.seedRun(RUN, { agentKind: 'claude' });
    await db.row(
      RUN,
      'tool_call',
      { id: 'h1', name: `mcp__${hostMcpServerName(RUN)}__show_chart` },
      '2026-11-01T10:00:00.000Z',
    );
    await db.feed(
      RUN,
      'tool_result',
      { id: 'h1', isError: false },
      '2026-11-01T10:00:00.400Z',
    );

    expect(await db.ledger.toolCalls({})).toMatchObject([
      {
        tool: 'show_chart',
        mcpServer: 'geniro',
        memberId: null,
        durationMs: 400,
      },
    ]);
  });

  it('counts no sub-agent call, and nothing for a run deleted before the result', async () => {
    await db.seedRun(RUN, { agentKind: 'claude' });
    await db.feed(
      RUN,
      'tool_call',
      { id: 's1', name: 'Read', parentToolUseId: 'task-1' },
      '2026-11-01T10:00:00.000Z',
    );
    await db.feed(
      RUN,
      'tool_result',
      { id: 's1', isError: false, parentToolUseId: 'task-1' },
      '2026-11-01T10:00:01.000Z',
    );
    await db.feed(
      RUN,
      'tool_call',
      { id: 'x', name: 'Read' },
      '2026-11-01T10:00:02.000Z',
    );
    await db.em.fork().nativeDelete(Run, { id: RUN });
    await db.feed(
      RUN,
      'tool_result',
      { id: 'x', isError: false },
      '2026-11-01T10:00:03.000Z',
    );

    expect(await db.ledger.toolCalls({})).toEqual([]);
  });
});

describe('ThreadMetricsLedgerService — stages, calls and outcomes', () => {
  let db: Db;

  beforeEach(async () => {
    db = await metricLedgerDb();
    await db.seedRun(RUN, { teamId: 'dev-team' });
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  const stage = (
    action: string,
    stageId: string,
    extra: Record<string, unknown> = {},
  ) => ({
    action,
    stageId,
    stageTitle: stageId,
    text: 'x',
    rev: 1,
    by: { kind: 'agent', nodeId: 'dev' },
    ...extra,
  });

  it('times each completed stage from the move before it, a skip included, and keeps hand-offs and reopens', async () => {
    await db.feed(
      RUN,
      'stage_change',
      stage('complete', 'plan'),
      '2026-11-01T09:10:00.000Z',
    );
    await db.feed(
      RUN,
      'stage_change',
      stage('handoff', 'build', { by: { kind: 'system' }, lead: 'builder' }),
      '2026-11-01T09:10:01.000Z',
    );
    await db.feed(
      RUN,
      'stage_change',
      stage('nudge', 'build', { by: { kind: 'system' } }),
      '2026-11-01T09:20:00.000Z',
    );
    await db.feed(
      RUN,
      'stage_change',
      stage('skip', 'lint'),
      '2026-11-01T09:25:00.000Z',
    );
    await db.feed(
      RUN,
      'stage_change',
      stage('complete', 'build'),
      '2026-11-01T09:40:00.000Z',
    );
    await db.feed(
      RUN,
      'stage_change',
      stage('reopen', 'build', { by: { kind: 'user', via: 'desktop' } }),
      '2026-11-01T09:45:00.000Z',
    );

    const rows = await db.ledger.stages({ teamSlug: 'dev-team' });
    expect(
      rows.map((row) => [
        row.action,
        row.stageId,
        row.durationMs,
        row.memberId,
        row.lead,
      ]),
    ).toEqual([
      ['complete', 'plan', 10 * 60_000, 'dev', null],
      ['handoff', 'build', null, null, 'builder'],
      ['skip', 'lint', null, 'dev', null],
      ['complete', 'build', 15 * 60_000, 'dev', null],
      ['reopen', 'build', null, null, null],
    ]);
  });

  it('records an ended call with its callee’s turns, spend and answer', async () => {
    await db.row(
      RUN,
      'call_started',
      { callId: 'call-1', callerNodeId: 'lead', calleeNodeId: 'dev' },
      '2026-11-01T10:00:00.000Z',
      'lead',
    );
    await db.row(
      RUN,
      'turn_complete',
      { callId: 'call-1', usage: { costUsd: 0.25 } },
      '2026-11-01T10:01:00.000Z',
      'dev',
    );
    await db.row(
      RUN,
      'turn_complete',
      { callId: 'call-1', usage: { costUsd: 0.5 } },
      '2026-11-01T10:02:00.000Z',
      'dev',
    );
    const result = await db.feed(
      RUN,
      'call_result',
      {
        callId: 'call-1',
        callerNodeId: 'lead',
        calleeNodeId: 'dev',
        mode: 'sync',
        status: 'ok',
      },
      '2026-11-01T10:03:00.000Z',
      'lead',
    );
    await db.service.observe({ runId: RUN, item: result });

    expect(await db.ledger.calls({ teamSlug: 'dev-team' })).toEqual([
      expect.objectContaining({
        callId: 'call-1',
        caller: 'lead',
        callee: 'dev',
        turns: 2,
        costUsd: 0.75,
        durationMs: 3 * 60_000,
        ok: true,
      }),
    ]);
  });

  it('keeps one thread outcome per run, moved only forward', async () => {
    const newer = await db.feed(
      RUN,
      'thread_outcome',
      {
        kind: 'success',
        summary: 'done',
        teamSlug: 'dev-team',
        nodeId: 'dev',
        conversationId: null,
      },
      '2026-11-01T11:00:00.000Z',
      'dev',
    );
    await db.feed(
      RUN,
      'thread_outcome',
      {
        kind: 'partial',
        summary: 'half',
        teamSlug: 'dev-team',
        nodeId: 'dev',
        conversationId: null,
      },
      '2026-11-01T11:05:00.000Z',
      'dev',
    );
    await db.service.observe({ runId: RUN, item: newer });

    expect(await db.ledger.threadOutcomes({})).toEqual([
      expect.objectContaining({ runId: RUN, kind: 'partial' }),
    ]);
  });
});

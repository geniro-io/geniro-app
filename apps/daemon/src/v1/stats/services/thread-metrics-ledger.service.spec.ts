import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('journals no sub-agent call, and nothing for a run deleted before the result', async () => {
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
    db.bus.publishRunDeleted(RUN);
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

describe('usage counters — what the observers count', () => {
  let db: Db;
  const GENIRO = `mcp__${hostMcpServerName(RUN)}__`;

  beforeEach(async () => {
    db = await metricLedgerDb();
    await db.seedRun(RUN, { agentKind: 'claude', projectId: 'p1' });
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  const counted = async () => {
    await db.counters.flush();
    return db.counterDao.rows();
  };

  const find = async (subjectKind: string, subject: string) =>
    (await counted()).filter(
      (row) => row.subjectKind === subjectKind && row.subject === subject,
    );

  it("journals an agent's own call and counts it direct; a sub-agent's call is only counted, as subagent", async () => {
    await db.feed(
      RUN,
      'tool_call',
      { id: 'a', name: 'Read' },
      '2026-11-01T10:00:00.000Z',
    );
    await db.feed(
      RUN,
      'tool_result',
      { id: 'a', isError: false, result: 'twelve chars' },
      '2026-11-01T10:00:02.000Z',
    );
    await db.feed(
      RUN,
      'tool_call',
      { id: 'a', name: 'Read', parentToolUseId: 'task-1' },
      '2026-11-01T10:00:03.000Z',
    );
    await db.feed(
      RUN,
      'tool_result',
      {
        id: 'a',
        isError: true,
        parentToolUseId: 'task-1',
        result: [{ type: 'text', text: 'abc' }],
      },
      '2026-11-01T10:00:04.000Z',
    );

    expect(await db.ledger.toolCalls({})).toHaveLength(1);
    const rows = await find('tool', 'Read');
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: 'direct',
          agentKind: 'claude',
          projectId: 'p1',
          calls: 1,
          errors: 0,
          durationMsTotal: 2_000,
          timedCalls: 1,
          resultCharsTotal: 12,
          sizedCalls: 1,
        }),
        expect.objectContaining({
          origin: 'subagent',
          calls: 1,
          errors: 1,
          durationMsTotal: 1_000,
          resultCharsTotal: 3,
        }),
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it("does not count live a journaled call from before the backfill's cutoff", async () => {
    await db.backfill.onModuleInit();
    await db.feed(
      RUN,
      'tool_call',
      { id: 'old', name: 'Read' },
      '2020-01-01T00:00:00.000Z',
    );
    await db.feed(
      RUN,
      'tool_result',
      { id: 'old', isError: false },
      '2020-01-01T00:00:01.000Z',
    );

    expect(await db.ledger.toolCalls({})).toHaveLength(1);
    expect(await find('tool', 'Read')).toEqual([]);
  });

  it('adds a denied permission request to the tool it named and to the capability', async () => {
    await db.feed(
      RUN,
      'approval_request',
      { id: 'q1', toolName: `${GENIRO}memory_read`, input: {} },
      '2026-11-01T10:00:00.000Z',
    );
    await db.feed(
      RUN,
      'approval_verdict',
      { id: 'q1', allow: false },
      '2026-11-01T10:00:01.000Z',
    );

    expect(await find('capability', 'permission_request')).toEqual([
      expect.objectContaining({ calls: 1, refused: 1 }),
    ]);
    expect(await find('tool', 'memory_read')).toEqual([
      expect.objectContaining({ source: 'geniro', calls: 0, refused: 1 }),
    ]);
  });

  it("counts a denied card of geniro's own as no permission request", async () => {
    await db.registry.registerGeniroTools(['propose_plan']);
    await db.feed(
      RUN,
      'approval_request',
      { id: 'c1', toolName: 'propose_plan', input: {} },
      '2026-11-01T10:00:00.000Z',
    );
    await db.feed(
      RUN,
      'approval_verdict',
      { id: 'c1', allow: false },
      '2026-11-01T10:00:01.000Z',
    );

    expect(await find('capability', 'permission_request')).toEqual([]);
    expect(await find('tool', 'propose_plan')).toEqual([]);
  });

  it('adds a denied codex approval that names only its server to the capability alone', async () => {
    await db.seedRun('run-codex-1', { agentKind: 'codex' });
    await db.feed(
      'run-codex-1',
      'approval_request',
      { id: 'q2', toolName: 'mcp__srv', input: {} },
      '2026-11-01T10:00:00.000Z',
    );
    await db.feed(
      'run-codex-1',
      'approval_verdict',
      { id: 'q2', allow: false },
      '2026-11-01T10:00:01.000Z',
    );

    const rows = await counted();
    expect(rows.filter((row) => row.subjectKind === 'tool')).toEqual([]);
    expect(rows).toEqual([
      expect.objectContaining({
        subject: 'permission_request',
        calls: 1,
        refused: 1,
      }),
    ]);
  });

  it('counts a question card and its dismissal on the capability only', async () => {
    await db.feed(
      RUN,
      'approval_request',
      {
        id: 'q3',
        toolName: 'AskUserQuestion',
        questions: [{ question: 'Which?' }],
      },
      '2026-11-01T10:00:00.000Z',
    );
    await db.feed(
      RUN,
      'approval_verdict',
      { id: 'q3', allow: false },
      '2026-11-01T10:00:01.000Z',
    );

    expect(await counted()).toEqual([
      expect.objectContaining({
        subject: 'question_card',
        calls: 1,
        refused: 1,
      }),
    ]);
  });

  it('counts a compaction, and one sub-agent however often it is announced', async () => {
    await db.feed(
      RUN,
      'system',
      { message: 'compacted', compaction: { trigger: 'auto' } },
      '2026-11-01T10:00:00.000Z',
    );
    for (const at of ['10:00:01', '10:00:02', '10:00:03']) {
      await db.feed(
        RUN,
        'subagent_info',
        { id: 'task-1', status: 'running' },
        `2026-11-01T${at}.000Z`,
      );
    }
    await db.feed(
      RUN,
      'subagent_info',
      { id: 'task-2' },
      '2026-11-01T10:00:04.000Z',
    );

    expect((await find('capability', 'compaction'))[0]).toMatchObject({
      calls: 1,
    });
    expect((await find('capability', 'subagent'))[0]).toMatchObject({
      calls: 2,
    });
  });

  it("counts a skill by name and a slash command by name, storing neither's arguments", async () => {
    await db.feed(
      RUN,
      'tool_call',
      {
        id: 's',
        name: 'Skill',
        input: { skill: 'geniro:review', args: 'SECRET-ARGS' },
      },
      '2026-11-01T10:00:00.000Z',
    );
    const user = (text: string, at: string) =>
      db.feed(RUN, 'message', { text }, at, null, null, 'user');
    await user('/review foo-bar-arg', '2026-11-01T10:00:01.000Z');
    await user('/compact', '2026-11-01T10:00:02.000Z');
    await user('/Users/x/y.ts is broken', '2026-11-01T10:00:03.000Z');
    await db.feed(
      RUN,
      'message',
      { text: '/plan from the agent' },
      '2026-11-01T10:00:04.000Z',
    );

    const rows = await counted();
    expect(rows.filter((row) => row.subjectKind === 'skill')).toEqual([
      expect.objectContaining({ subject: 'geniro:review', calls: 1 }),
    ]);
    expect(rows.filter((row) => row.subjectKind === 'command')).toEqual([
      expect.objectContaining({ subject: 'review', calls: 1 }),
    ]);
    const stored =
      JSON.stringify(rows) + JSON.stringify(await db.counterDao.subjects());
    expect(stored).not.toContain('SECRET-ARGS');
    expect(stored).not.toContain('foo-bar-arg');
  });

  it('counts a stage move but a nudge, an answered call, and only the first outcome of a run', async () => {
    const stage = (action: string) => ({
      action,
      stageId: 'build',
      stageTitle: 'Build',
      text: 'x',
      rev: 1,
      by: { kind: 'agent', nodeId: 'lead' },
    });
    await db.feed(
      RUN,
      'stage_change',
      stage('complete'),
      '2026-11-01T10:00:00.000Z',
    );
    await db.feed(
      RUN,
      'stage_change',
      stage('nudge'),
      '2026-11-01T10:00:01.000Z',
    );
    await db.feed(
      RUN,
      'call_result',
      {
        callId: 'c1',
        callerNodeId: 'lead',
        calleeNodeId: 'qa',
        status: 'failed',
      },
      '2026-11-01T10:00:02.000Z',
    );
    const outcome = (kind: string) => ({
      kind,
      summary: kind,
      teamSlug: 'dev-team',
      nodeId: 'dev',
      conversationId: null,
    });
    await db.feed(
      RUN,
      'thread_outcome',
      outcome('failed'),
      '2026-11-01T10:00:03.000Z',
    );
    await db.feed(
      RUN,
      'thread_outcome',
      outcome('success'),
      '2026-11-01T10:00:04.000Z',
    );

    expect((await find('capability', 'stage_move'))[0]).toMatchObject({
      calls: 1,
    });
    expect((await find('capability', 'agent_call'))[0]).toMatchObject({
      calls: 1,
      errors: 1,
    });
    expect((await find('capability', 'thread_outcome'))[0]).toMatchObject({
      calls: 1,
      errors: 1,
    });
  });

  it('counts a tool list once per session, and a refused Geniro answer once', async () => {
    const offered = {
      kind: 'tools_offered' as const,
      runId: RUN,
      memberId: null,
      conversationId: null,
      tools: ['goals', 'memory_read'],
    };
    await db.observer.observeSignal(offered);
    await db.observer.observeSignal(offered);
    await db.observer.observeSignal({ ...offered, conversationId: 'conv-2' });
    await db.observer.observeSignal({
      kind: 'geniro_tool_answered',
      runId: RUN,
      memberId: null,
      tool: 'memory_read',
      outcome: 'refused',
    });
    await db.observer.observeSignal({
      kind: 'geniro_tool_answered',
      runId: RUN,
      memberId: null,
      tool: 'memory_read',
      outcome: 'failed',
    });

    expect((await find('tool', 'goals'))[0]).toMatchObject({
      offeredSessions: 2,
      calls: 0,
    });
    expect((await find('tool', 'memory_read'))[0]).toMatchObject({
      offeredSessions: 2,
      refused: 1,
      errors: 0,
    });
  });

  it('counts nothing for a run it cannot find, and a skill a sub-agent ran as subagent', async () => {
    await db.feed(
      'run-gone-01',
      'subagent_info',
      { id: 'task-1' },
      '2026-11-01T10:00:00.000Z',
    );
    await db.feed(
      RUN,
      'tool_call',
      {
        id: 's',
        name: 'Skill',
        input: { skill: 'geniro:debug' },
        parentToolUseId: 'task-2',
      },
      '2026-11-01T10:00:01.000Z',
    );

    expect(await counted()).toEqual([
      expect.objectContaining({
        subjectKind: 'skill',
        subject: 'geniro:debug',
        origin: 'subagent',
        calls: 1,
      }),
    ]);
  });

  it('swallows a failed read of the run, and counts the next row', async () => {
    const read = vi
      .spyOn(db.runDao, 'usageFacts')
      .mockRejectedValueOnce(new Error('database is locked'));
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    await db.seedRun('run-fresh-01', { agentKind: 'claude' });

    await expect(
      db.feed(
        'run-fresh-01',
        'subagent_info',
        { id: 'a' },
        '2026-11-01T10:00:00.000Z',
      ),
    ).resolves.toBeDefined();
    await db.feed(
      'run-fresh-01',
      'subagent_info',
      { id: 'b' },
      '2026-11-01T10:00:01.000Z',
    );

    expect(read).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('database is locked'),
    );
    expect((await find('capability', 'subagent'))[0]).toMatchObject({
      calls: 1,
    });
    warn.mockRestore();
  });

  it('counts an analysis run by its purpose and a capability a service signalled', async () => {
    await db.seedRun('run-analysis', {
      analysisPurpose: 'review',
      analysisTeamSlug: 'dev-team',
    });
    await db.observer.observeRunCreated({
      runId: 'run-analysis',
      createdAt: '2026-11-01T10:00:00.000Z',
    });
    await db.observer.observeSignal({
      kind: 'capability',
      runId: null,
      capability: 'autopilot_card_start',
      ok: true,
    });

    expect((await find('capability', 'team_analysis'))[0]).toMatchObject({
      calls: 1,
    });
    expect((await find('capability', 'autopilot_card_start'))[0]).toMatchObject(
      {
        calls: 1,
        agentKind: '',
        projectId: '',
      },
    );
  });
});

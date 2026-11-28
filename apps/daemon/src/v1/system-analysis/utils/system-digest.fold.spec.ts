import { describe, expect, it } from 'vitest';

import type { AgentFlagWire } from '../../agents/chat.types';
import {
  SYSTEM_ANALYSIS_MAX_THREADS,
  SYSTEM_DIGEST_GONE_FLAGS,
  SYSTEM_DIGEST_TOOL_ERRORS,
  SYSTEM_DIGEST_TOOL_ERRORS_PER_THREAD,
  SYSTEM_DIGEST_TOOL_USAGE_ROWS,
  SYSTEM_DIGEST_TOOLS_PER_THREAD,
  SystemDigestSchema,
  type SystemPeriod,
} from '../system-analysis.types';
import {
  type DigestCandidate,
  type DigestFailedCall,
  digestScore,
  digestToolUsage,
  foldSystemDigest,
} from './system-digest.fold';

const PERIOD: SystemPeriod = {
  from: '2026-11-01T00:00:00.000Z',
  to: '2026-11-08T00:00:00.000Z',
  days: 7,
};
const AT = new Date('2026-11-05T10:00:00.000Z');

function candidate(
  runId: string,
  over: Partial<DigestCandidate> = {},
): DigestCandidate {
  return {
    runId,
    title: runId,
    kind: 'chat',
    teamSlug: null,
    projectId: null,
    archived: false,
    lastActivityAt: AT,
    snapshotSeq: 9,
    failedTools: [],
    outcome: null,
    unmetGoals: 0,
    refusedApprovals: 0,
    corrections: 0,
    analysisRefusals: 0,
    ...over,
  };
}

function failed(
  tool: string,
  mcpServer: string | null,
  seq = 1,
  error: string | null = null,
): DigestFailedCall {
  return { seq, tool, mcpServer, error };
}

const NO_SIGNALS = {
  workFlags: 0,
  disagreementFlags: 0,
  outcome: null,
  unmetGoals: 0,
  refusedApprovals: 0,
  corrections: 0,
  analysisRefusals: 0,
  failedToolCalls: 0,
  failedToolCallsByKind: { geniro: 0, otherMcp: 0, shell: 0 },
};

function flag(
  runId: string,
  cost: AgentFlagWire['cost'],
  handle = `F-${runId}-${cost}`,
): AgentFlagWire {
  return {
    handle,
    runId,
    seq: 1,
    occurredAt: AT.toISOString(),
    memberId: null,
    callId: null,
    agentKind: null,
    model: null,
    teamSlug: null,
    projectId: null,
    runKind: 'chat',
    runTitle: null,
    cost,
    category: 'other',
    minutesLost: null,
    summary: 'a problem',
    detail: null,
    automatic: false,
  };
}

function fold(over: Partial<Parameters<typeof foldSystemDigest>[0]> = {}) {
  return foldSystemDigest({
    period: PERIOD,
    candidates: [],
    flags: [],
    goneRunIds: new Set(),
    ...over,
  });
}

describe('digestScore', () => {
  it('weighs each counted signal, with failed MCP tool calls capped', () => {
    expect(
      digestScore({
        workFlags: 1,
        disagreementFlags: 1,
        outcome: 'partial',
        unmetGoals: 2,
        refusedApprovals: 1,
        corrections: 1,
        analysisRefusals: 1,
        failedToolCalls: 40,
        failedToolCallsByKind: { geniro: 30, otherMcp: 10, shell: 0 },
      }),
    ).toBe(35);
  });

  it('scores a thread with no signal at zero', () => {
    expect(digestScore(NO_SIGNALS)).toBe(0);
  });

  it('weighs failed geniro and other MCP calls, and never shell or file tool failures', () => {
    expect(
      digestScore({
        ...NO_SIGNALS,
        failedToolCalls: 9,
        failedToolCallsByKind: { geniro: 2, otherMcp: 1, shell: 6 },
      }),
    ).toBe(3);
    expect(
      digestScore({
        ...NO_SIGNALS,
        failedToolCalls: 40,
        failedToolCallsByKind: { geniro: 0, otherMcp: 0, shell: 40 },
      }),
    ).toBe(0);
  });
});

describe('foldSystemDigest', () => {
  it('leaves out a thread with no signal, and counts only threads that have one', () => {
    const digest = fold({
      candidates: [candidate('quiet'), candidate('busy')],
      flags: [flag('busy', 'work')],
    });

    expect(digest.threads.map((thread) => thread.runId)).toEqual(['busy']);
    expect(digest.totals.threadsWithSignals).toBe(1);
  });

  it('ranks the most troubled thread first', () => {
    const digest = fold({
      candidates: [
        candidate('refused', { analysisRefusals: 1 }),
        candidate('failed', { outcome: 'failed' }),
        candidate('flagged'),
      ],
      flags: [flag('flagged', 'work')],
    });

    expect(digest.threads.map((thread) => thread.runId)).toEqual([
      'flagged',
      'failed',
      'refused',
    ]);
  });

  it('orders ties by newest activity, then by run id', () => {
    const older = new Date('2026-11-04T10:00:00.000Z');
    const digest = fold({
      candidates: [
        candidate('a', { lastActivityAt: older }),
        candidate('c'),
        candidate('b'),
      ],
      flags: [flag('a', 'work'), flag('b', 'work'), flag('c', 'work')],
    });

    expect(digest.threads.map((thread) => thread.runId)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('caps the threads it lists at the most troubled ones, counting every thread with a signal', () => {
    expect(SYSTEM_ANALYSIS_MAX_THREADS).toBe(30);
    const candidates = Array.from(
      { length: SYSTEM_ANALYSIS_MAX_THREADS + 1 },
      (_, index) =>
        candidate(`r${String(index).padStart(2, '0')}`, {
          analysisRefusals: index + 1,
        }),
    );

    const digest = fold({ candidates });

    expect(digest.threads).toHaveLength(SYSTEM_ANALYSIS_MAX_THREADS);
    expect(digest.threads[0]?.runId).toBe('r30');
    expect(digest.threads.map((thread) => thread.runId)).not.toContain('r00');
    expect(digest.totals.threadsWithSignals).toBe(
      SYSTEM_ANALYSIS_MAX_THREADS + 1,
    );
  });

  it('lists the flags of a thread it reads, and not those of a run it does not read', () => {
    const digest = fold({
      candidates: [candidate('busy'), candidate('quiet')],
      flags: [
        flag('busy', 'work', 'F-busy'),
        flag('not-a-candidate', 'work', 'F-elsewhere'),
      ],
    });

    expect(digest.flags.map((item) => item.handle)).toEqual(['F-busy']);
    expect(digest.totals.flags).toBe(2);
  });

  it('lists a flag of a deleted run under goneFlags, and never among the flags', () => {
    const digest = fold({
      candidates: [candidate('busy')],
      flags: [flag('busy', 'work', 'F-busy'), flag('gone', 'work', 'F-gone')],
      goneRunIds: new Set(['gone']),
    });

    expect(digest.goneFlags.map((item) => item.handle)).toEqual(['F-gone']);
    expect(digest.flags.map((item) => item.handle)).toEqual(['F-busy']);
  });

  it('keeps the newest gone flags, at most the limit', () => {
    const flags = Array.from({ length: SYSTEM_DIGEST_GONE_FLAGS + 1 }, (_, i) =>
      flag('gone', 'work', `F-g${i}`),
    );

    const digest = fold({ flags, goneRunIds: new Set(['gone']) });

    expect(digest.goneFlags).toHaveLength(SYSTEM_DIGEST_GONE_FLAGS);
    expect(digest.goneFlags[0]?.handle).toBe('F-g1');
    expect(digest.goneFlags.at(-1)?.handle).toBe(
      `F-g${SYSTEM_DIGEST_GONE_FLAGS}`,
    );
  });

  it('groups failed tool calls by tool and server, most frequent first, at most the per-thread limit', () => {
    const calls = [
      ...Array.from({ length: 3 }, () => failed('read', null)),
      ...Array.from({ length: 2 }, () => failed('bash', 'git')),
      ...['t4', 't3', 't2', 't1', 't0', 't5'].map((tool) => failed(tool, null)),
    ];

    const digest = fold({
      candidates: [candidate('busy', { failedTools: calls })],
    });
    const [thread] = digest.threads;

    expect(thread?.failedTools).toHaveLength(SYSTEM_DIGEST_TOOLS_PER_THREAD);
    expect(thread?.failedTools.slice(0, 3)).toEqual([
      { tool: 'read', mcpServer: null, failures: 3 },
      { tool: 'bash', mcpServer: 'git', failures: 2 },
      { tool: 't0', mcpServer: null, failures: 1 },
    ]);
    expect(thread?.signals.failedToolCalls).toBe(calls.length);
    expect(thread?.signals.failedToolCallsByKind).toEqual({
      geniro: 0,
      otherMcp: 2,
      shell: 9,
    });
  });

  it('counts the lessons threads among the system threads', () => {
    const digest = fold({
      candidates: [
        candidate('reflection', { kind: 'lessons', analysisRefusals: 1 }),
        candidate('chat'),
      ],
      flags: [flag('chat', 'work')],
    });

    expect(digest.totals.systemThreads).toBe(1);
  });

  it('counts the failed tool calls of every thread, ranked or not, split by where the tool came from', () => {
    const digest = fold({
      candidates: [
        candidate('a', {
          failedTools: [failed('x', null, 1), failed('x', null, 2)],
        }),
        candidate('b', {
          failedTools: [
            failed('y', 'geniro', 1, 'INVALID_ARGS: no'),
            failed('z', 'git', 2),
          ],
        }),
      ],
    });

    expect(digest.threads.map((thread) => thread.runId)).toEqual(['b']);
    expect(digest.totals.failedToolCalls).toBe(4);
    expect(digest.totals.failedToolCallsByKind).toEqual({
      geniro: 1,
      otherMcp: 1,
      shell: 2,
    });
  });

  it('leaves out a thread whose only signal is shell and file tool failures', () => {
    const digest = fold({
      candidates: [
        candidate('shell-only', {
          failedTools: Array.from({ length: 30 }, (_, seq) =>
            failed('Bash', null, seq),
          ),
        }),
      ],
    });

    expect(digest.threads).toEqual([]);
    expect(digest.totals.threadsWithSignals).toBe(0);
    expect(digest.totals.failedToolCallsByKind?.shell).toBe(30);
  });

  it("signs each thread's geniro tool failures with digits and ids masked, most frequent first, at most the per-thread limit", () => {
    const calls = [
      failed(
        'stop_monitor',
        'geniro',
        10,
        'INVALID_ARGS: already ended: exit code 1',
      ),
      failed(
        'stop_monitor',
        'geniro',
        20,
        'INVALID_ARGS: already ended: exit code 137',
      ),
      failed(
        'stop_monitor',
        'geniro',
        30,
        'INVALID_ARGS: already ended: exit code 2',
      ),
      failed(
        'await_agent',
        'geniro',
        40,
        'NO_SUCH_CALL: 1f2e3d4c-aaaa-bbbb-cccc-0123456789ab',
      ),
      ...['t1', 't2', 't3', 't4', 't5'].map((tool, index) =>
        failed(tool, 'geniro', 50 + index, `E: ${tool}`),
      ),
      failed('Bash', null, 90, 'Exit code 2'),
    ];

    const digest = fold({
      candidates: [candidate('busy', { failedTools: calls })],
    });
    const errors = digest.threads[0]?.geniroToolErrors ?? [];

    expect(errors).toHaveLength(SYSTEM_DIGEST_TOOL_ERRORS_PER_THREAD);
    expect(errors.slice(0, 2)).toEqual([
      {
        tool: 'stop_monitor',
        signature: 'INVALID_ARGS: already ended: exit code #',
        count: 3,
        example: { runId: 'busy', seq: 10 },
      },
      {
        tool: 'await_agent',
        signature: 'NO_SUCH_CALL: <id>',
        count: 1,
        example: { runId: 'busy', seq: 40 },
      },
    ]);
    expect(errors.map((error) => error.tool)).not.toContain('Bash');
  });

  it("signs the period's geniro tool failures over every thread, counting every call past the cap", () => {
    const tools = Array.from(
      { length: SYSTEM_DIGEST_TOOL_ERRORS + 2 },
      (_, index) => `tool_${String(index).padStart(2, '0')}`,
    );
    const digest = fold({
      candidates: [
        candidate('quiet', {
          failedTools: [
            failed(
              'stop_monitor',
              'geniro',
              5,
              'INVALID_ARGS: already ended: exit code 1',
            ),
          ],
        }),
        candidate('busy', {
          failedTools: [
            failed(
              'stop_monitor',
              'geniro',
              7,
              'INVALID_ARGS: already ended: exit code 9',
            ),
            ...tools.map((tool, index) =>
              failed(tool, 'geniro', 100 + index, 'NOT_FOUND'),
            ),
          ],
        }),
      ],
      flags: [flag('busy', 'work')],
    });

    expect(digest.totals.geniroToolErrorGroups).toBe(tools.length + 1);
    expect(digest.geniroToolErrors).toHaveLength(SYSTEM_DIGEST_TOOL_ERRORS);
    expect(digest.geniroToolErrors?.[0]).toEqual({
      tool: 'stop_monitor',
      signature: 'INVALID_ARGS: already ended: exit code #',
      count: 2,
      threads: 2,
      readable: true,
      example: { runId: 'busy', seq: 7 },
      error: 'INVALID_ARGS: already ended: exit code 9',
    });
  });

  it('names an example from a thread the digest reads first, and marks one only an unread thread has', () => {
    const ranked = Array.from(
      { length: SYSTEM_ANALYSIS_MAX_THREADS },
      (_, index) =>
        candidate(`read-${String(index).padStart(2, '0')}`, {
          analysisRefusals: 1,
          failedTools: [
            failed('goals', 'geniro', 1, 'INVALID_ARGS: no goal 4'),
          ],
        }),
    );
    const unread = candidate('unread', {
      lastActivityAt: new Date('2026-11-02T10:00:00.000Z'),
      failedTools: [
        failed('goals', 'geniro', 9, 'INVALID_ARGS: no goal 7'),
        failed('browser_click', 'geniro', 10, 'NO_SUCH_TAB: tab 3'),
      ],
    });

    const digest = fold({ candidates: [unread, ...ranked] });
    const byTool = new Map(
      (digest.geniroToolErrors ?? []).map((error) => [error.tool, error]),
    );

    expect(digest.threads.map((thread) => thread.runId)).not.toContain(
      'unread',
    );
    expect(byTool.get('goals')).toMatchObject({
      count: SYSTEM_ANALYSIS_MAX_THREADS + 1,
      readable: true,
    });
    expect(byTool.get('goals')?.example.runId).not.toBe('unread');
    expect(byTool.get('browser_click')).toMatchObject({
      count: 1,
      readable: false,
      example: { runId: 'unread', seq: 10 },
    });
  });

  it('signs a geniro tool failure whose error text could not be read apart from the others', () => {
    const digest = fold({
      candidates: [
        candidate('busy', {
          failedTools: [failed('goals', 'geniro', 3, null)],
        }),
      ],
    });

    expect(digest.geniroToolErrors?.[0]).toMatchObject({
      tool: 'goals',
      signature: '(no error text)',
      count: 1,
    });
  });

  it('carries each read thread its identity, snapshot and score', () => {
    const digest = fold({
      candidates: [candidate('busy', { teamSlug: 'team', archived: true })],
      flags: [flag('busy', 'work')],
    });

    expect(digest.threads[0]).toMatchObject({
      runId: 'busy',
      teamSlug: 'team',
      archived: true,
      snapshotSeq: 9,
      lastActivityAt: AT.toISOString(),
      score: 5,
    });
    expect(digest.period).toEqual(PERIOD);
  });
});

describe('digestToolUsage', () => {
  const row = (subject: string, calls: number) => ({
    subjectKind: 'tool' as const,
    subject,
    source: '',
    calls,
    subagentCalls: 0,
    agents: [],
    errors: 0,
    refused: 0,
    avgDurationMs: null,
    avgResultChars: null,
    firstAt: null,
    lastAt: null,
    firstKnownAt: null,
    offeredSessions: null,
    removalEligible: false,
  });

  it('keeps the most called subjects up to the cap, counts the rest, and lists every never-called one', () => {
    const rows = Array.from(
      { length: SYSTEM_DIGEST_TOOL_USAGE_ROWS + 2 },
      (_, i) => row(`t${i}`, 1_000 - i),
    );
    const usage = digestToolUsage(
      {
        countingSince: '2026-10-01T00:00:00.000Z',
        liveSince: '2026-11-20T00:00:00.000Z',
        rows,
        neverCalled: [
          { ...row('note_thread', 0), source: 'geniro', removalEligible: true },
        ],
      },
      '2026-11-27T10:00:00.000Z',
    );

    expect(usage.rows).toHaveLength(SYSTEM_DIGEST_TOOL_USAGE_ROWS);
    expect(usage.leftOut).toBe(2);
    expect(usage.subjects).toBe(SYSTEM_DIGEST_TOOL_USAGE_ROWS + 2);
    expect(usage.rows[0]).toMatchObject({ name: 't0', calls: 1_000 });
    expect(usage.neverCalled).toEqual([
      expect.objectContaining({
        name: 'note_thread',
        removable: true,
        source: 'geniro',
      }),
    ]);
  });

  it('still reads a digest frozen before tool usage existed', () => {
    expect(
      SystemDigestSchema.safeParse({
        period: {
          from: '2026-11-01T00:00:00.000Z',
          to: '2026-11-08T00:00:00.000Z',
          days: 7,
        },
        totals: {
          threadsWithSignals: 0,
          flags: 0,
          failedToolCalls: 0,
          systemThreads: 0,
        },
        flags: [],
        goneFlags: [],
        threads: [],
      }).success,
    ).toBe(true);
  });
});

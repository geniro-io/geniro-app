import { describe, expect, it } from 'vitest';

import type { AgentFlagWire } from '../../agents/chat.types';
import {
  SYSTEM_ANALYSIS_MAX_THREADS,
  SYSTEM_DIGEST_GONE_FLAGS,
  SYSTEM_DIGEST_TOOLS_PER_THREAD,
  type SystemPeriod,
} from '../system-analysis.types';
import {
  type DigestCandidate,
  digestScore,
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
  it('weighs each counted signal, with failed tool calls capped', () => {
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
      }),
    ).toBe(35);
  });

  it('scores a thread with no signal at zero', () => {
    expect(
      digestScore({
        workFlags: 0,
        disagreementFlags: 0,
        outcome: null,
        unmetGoals: 0,
        refusedApprovals: 0,
        corrections: 0,
        analysisRefusals: 0,
        failedToolCalls: 0,
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
    const failed = [
      ...Array.from({ length: 3 }, () => ({ tool: 'read', mcpServer: null })),
      ...Array.from({ length: 2 }, () => ({ tool: 'bash', mcpServer: 'git' })),
      ...['t4', 't3', 't2', 't1', 't0', 't5'].map((tool) => ({
        tool,
        mcpServer: null,
      })),
    ];

    const digest = fold({
      candidates: [candidate('busy', { failedTools: failed })],
    });
    const [thread] = digest.threads;

    expect(thread?.failedTools).toHaveLength(SYSTEM_DIGEST_TOOLS_PER_THREAD);
    expect(thread?.failedTools.slice(0, 3)).toEqual([
      { tool: 'read', mcpServer: null, failures: 3 },
      { tool: 'bash', mcpServer: 'git', failures: 2 },
      { tool: 't0', mcpServer: null, failures: 1 },
    ]);
    expect(thread?.signals.failedToolCalls).toBe(failed.length);
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

  it('sums the failed tool calls of the threads it ranks', () => {
    const digest = fold({
      candidates: [
        candidate('a', {
          failedTools: [
            { tool: 'x', mcpServer: null },
            { tool: 'x', mcpServer: null },
          ],
        }),
        candidate('b', {
          failedTools: [{ tool: 'y', mcpServer: null }],
        }),
      ],
    });

    expect(digest.totals.failedToolCalls).toBe(3);
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

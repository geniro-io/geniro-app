import { describe, expect, it } from 'vitest';

import type { MemberTurnReading } from '../../agents/chat.types';
import {
  foldFreshStarts,
  type FreshSessionRun,
  median,
} from './fresh-session-base';

const GENIRO = { projectId: 'p-geniro', name: 'Geniro' };
const MANIFEST = { projectId: 'p-manifest', name: 'ManifestOS' };

function run(
  id: string,
  group = GENIRO,
  cwd = `/repos/${id}`,
): FreshSessionRun {
  return { id, cwd, group };
}

function reading(
  runId: string,
  seq: number,
  fields: Partial<MemberTurnReading> = {},
): MemberTurnReading {
  return {
    runId,
    seq,
    kind: 'turn_complete',
    memberId: 'manager',
    createdAt: new Date(Date.UTC(2026, 10, 22, 0, 0, seq)),
    sessionId: `${runId}-s1`,
    contextTokens: 100_000,
    numTurns: 1,
    agent: 'claude',
    model: 'sonnet',
    poolMember: null,
    ...fields,
  };
}

describe('foldFreshStarts', () => {
  it('counts only the turn that opened each CLI session', () => {
    const [manager] = foldFreshStarts(
      [run('r1')],
      [
        reading('r1', 11, { contextTokens: 144_982, numTurns: 3 }),
        reading('r1', 40, { contextTokens: 190_000 }),
        reading('r1', 80, { contextTokens: 230_000 }),
      ],
    );

    expect(manager).toMatchObject({
      memberId: 'manager',
      starts: 1,
      baseTokens: 144_982,
      minTokens: 144_982,
      maxTokens: 144_982,
      medianRequests: 3,
      newestRunId: 'r1',
      newestCwd: '/repos/r1',
    });
  });

  it('opens a session once per run, whatever order the rows arrive in', () => {
    const [manager] = foldFreshStarts(
      [run('r1')],
      [
        reading('r1', 90, { contextTokens: 250_000 }),
        reading('r1', 5, { contextTokens: 120_000 }),
      ],
    );

    expect(manager!.baseTokens).toBe(120_000);
  });

  it('leaves out a session whose opening turn reported no context, and rows with no session', () => {
    const folds = foldFreshStarts(
      [run('r1')],
      [
        reading('r1', 1, { contextTokens: null }),
        reading('r1', 2, { contextTokens: 300_000 }),
        reading('r1', 3, { sessionId: null, contextTokens: 50_000 }),
      ],
    );

    expect(folds).toEqual([]);
  });

  it('takes the median of the newest starts across runs, an older run included', () => {
    const runs = ['r1', 'r2', 'r3', 'r4'].map((id) => run(id));
    const readings = [
      reading('r1', 1, {
        contextTokens: 900_000,
        createdAt: new Date(Date.UTC(2026, 10, 1)),
      }),
      reading('r2', 1, {
        contextTokens: 120_000,
        createdAt: new Date(Date.UTC(2026, 10, 20)),
      }),
      reading('r3', 1, {
        contextTokens: 140_000,
        createdAt: new Date(Date.UTC(2026, 10, 21)),
      }),
      reading('r4', 1, {
        contextTokens: 130_000,
        createdAt: new Date(Date.UTC(2026, 10, 22)),
      }),
    ];

    const [all] = foldFreshStarts(runs, readings);
    const [newest] = foldFreshStarts(runs, readings, 3);

    expect(all).toMatchObject({
      starts: 4,
      baseTokens: 135_000,
      maxTokens: 900_000,
    });
    expect(all!.firstStartAt.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(newest).toMatchObject({
      starts: 3,
      baseTokens: 130_000,
      maxTokens: 140_000,
      newestRunId: 'r4',
    });
  });

  it('counts every session a member opened in one run — its own and each call', () => {
    const [callee] = foldFreshStarts(
      [run('r1')],
      [
        reading('r1', 1, {
          memberId: 'handyman',
          sessionId: 'a',
          contextTokens: 119_207,
        }),
        reading('r1', 9, {
          memberId: 'handyman',
          sessionId: 'b',
          contextTokens: 121_000,
        }),
      ],
    );

    expect(callee).toMatchObject({
      memberId: 'handyman',
      starts: 2,
      baseTokens: 120_104,
    });
  });

  it('files a pooled start under the pool member that ran it', () => {
    const folds = foldFreshStarts(
      [run('r1')],
      [
        reading('r1', 1, {
          sessionId: 'a',
          poolMember: 1,
          contextTokens: 150_000,
        }),
        reading('r1', 5, {
          sessionId: 'b',
          poolMember: 2,
          agent: 'codex',
          model: 'gpt-5',
          contextTokens: 40_000,
        }),
      ],
    );

    expect(
      folds.map((fold) => [fold.poolMember, fold.agent, fold.baseTokens]),
    ).toEqual([
      [1, 'claude', 150_000],
      [2, 'codex', 40_000],
    ]);
  });

  it('keeps each project apart, since the same member starts heavier in another repository', () => {
    const folds = foldFreshStarts(
      [run('r1', GENIRO), run('r2', MANIFEST)],
      [
        reading('r1', 1, { contextTokens: 144_982 }),
        reading('r2', 1, { contextTokens: 199_000 }),
      ],
    );

    expect(folds.map((fold) => [fold.group.name, fold.baseTokens])).toEqual([
      ['Geniro', 144_982],
      ['ManifestOS', 199_000],
    ]);
  });

  it('leaves out a session whose opening turn was cancelled or failed, so a later turn never passes for its start', () => {
    const folds = foldFreshStarts(
      [run('r1')],
      [
        reading('r1', 1, {
          sessionId: 'a',
          kind: 'turn_cancelled',
          contextTokens: 80_000,
        }),
        reading('r1', 2, { sessionId: 'a', contextTokens: 210_000 }),
        reading('r1', 3, {
          sessionId: 'b',
          kind: 'error',
          contextTokens: null,
        }),
        reading('r1', 4, { sessionId: 'b', contextTokens: 190_000 }),
        reading('r1', 5, { sessionId: 'c', contextTokens: 120_000 }),
      ],
    );

    expect(folds.map((fold) => [fold.starts, fold.baseTokens])).toEqual([
      [1, 120_000],
    ]);
  });

  it('ignores a row of a run it was not given', () => {
    expect(foldFreshStarts([run('r1')], [reading('gone', 1)])).toEqual([]);
  });
});

describe('median', () => {
  it('answers null for nothing, the middle value, or the two middle ones averaged', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 6])).toBe(3);
  });
});

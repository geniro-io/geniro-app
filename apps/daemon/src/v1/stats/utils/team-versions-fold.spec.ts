import { describe, expect, it, vi } from 'vitest';

import { member, teamOf } from '../../teams/__tests__/team-builders';
import type { LegacyTeamGraph, Team } from '../../teams/teams.types';
import {
  canonicalGraphJson,
  canonicalGraphOf,
  legacyCanonicalJson,
  legacyGraphVersionOf,
  teamVersionOf,
} from '../../teams/utils/team-version';
import {
  POLLED_SPEND_SEQ,
  type ThreadLedgerRow,
  type VersionChangesWire,
} from '../stats.types';
import {
  foldTeamVersions,
  type TeamVersionsInput,
  type UsageLedgerRow,
} from './team-versions-fold';

const v1: Team = teamOf([member('dev')], { name: 'Dev Team' });
const v2: Team = {
  ...v1,
  members: [...v1.members, member('qa', { agent: 'cursor-agent' })],
};
const V1 = teamVersionOf(v1);
const V2 = teamVersionOf(v2);

const graphs = [
  {
    version: V1,
    graph: canonicalGraphJson(canonicalGraphOf(v1)),
    firstSeenAt: new Date('2026-09-01T00:00:00Z'),
  },
  {
    version: V2,
    graph: canonicalGraphJson(canonicalGraphOf(v2)),
    firstSeenAt: new Date('2026-10-01T00:00:00Z'),
  },
];

const CHANGES: VersionChangesWire = { added: 3, removed: 0, diff: '+qa' };

function thread(
  runId: string,
  version: string | null,
  occurredAt: string,
  inferred = false,
): ThreadLedgerRow {
  return {
    runId,
    occurredAt: new Date(occurredAt),
    slug: 'dev-team',
    version,
    inferred: version === null ? null : inferred,
  };
}

function turn(
  runId: string,
  seq: number,
  figures: Partial<UsageLedgerRow> = {},
): UsageLedgerRow {
  return {
    runId,
    seq,
    agentKind: 'claude',
    costUsd: 1,
    estimatedCostUsd: null,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    thinkingTokens: null,
    durationMs: 1000,
    apiMs: null,
    ttftMs: null,
    timeToRequestMs: null,
    numTurns: null,
    ...figures,
  };
}

function input(overrides: Partial<TeamVersionsInput>): TeamVersionsInput {
  return {
    slug: 'dev-team',
    currentVersion: V2,
    threads: [],
    usage: [],
    polledKinds: ['cursor-agent'],
    graphs,
    unrecorded: null,
    changesOf: () => CHANGES,
    ...overrides,
  };
}

describe('foldTeamVersions', () => {
  it('counts each version’s runs and cost, a run years old included, and folds the total over every run', () => {
    const result = foldTeamVersions(
      input({
        threads: [
          thread('ancient', V1, '2021-01-01T00:00:00Z'),
          thread('a', V1, '2026-09-02T00:00:00Z'),
          thread('b', V2, '2026-10-02T00:00:00Z'),
          thread('c', V2, '2026-10-03T00:00:00Z'),
        ],
        usage: [
          turn('ancient', 1),
          turn('a', 1),
          turn('a', 2),
          turn('b', 1, { costUsd: 4 }),
          turn('c', 1),
        ],
      }),
    );

    expect(result.versions.map((row) => [row.version, row.ordinal])).toEqual([
      [V2, 2],
      [V1, 1],
    ]);
    const [second, first] = result.versions;
    expect(first).toMatchObject({
      firstRunAt: '2021-01-01T00:00:00.000Z',
      lastRunAt: '2026-09-02T00:00:00.000Z',
      figures: { runs: 2, costUsd: 3, avgCostUsd: 1.5 },
    });
    expect(second!.figures).toMatchObject({
      runs: 2,
      costUsd: 5,
      avgCostUsd: 2.5,
    });
    expect(result.totals).toMatchObject({
      runs: 4,
      costUsd: 8,
      avgCostUsd: 2,
    });
  });

  it('averages over the runs that reported a cost, and reads none as not measured', () => {
    const result = foldTeamVersions(
      input({
        threads: [
          thread('priced', V2, '2026-10-02T00:00:00Z'),
          thread('silent', V2, '2026-10-03T00:00:00Z'),
          thread('old', V1, '2026-09-02T00:00:00Z'),
        ],
        usage: [
          turn('priced', 1, { costUsd: 6, estimatedCostUsd: 2 }),
          turn('silent', 1, { costUsd: null }),
          turn('old', 1, { costUsd: null }),
        ],
      }),
    );

    expect(result.versions[0]!.figures).toEqual({
      runs: 2,
      costUsd: 6,
      avgCostUsd: 6,
      estimatedCostUsd: 2,
    });
    expect(result.versions[1]!.figures).toEqual({
      runs: 1,
      costUsd: null,
      avgCostUsd: null,
      estimatedCostUsd: null,
    });
  });

  it('credits a run’s polled bill once, over its unpriced turns of a polled CLI', () => {
    const result = foldTeamVersions(
      input({
        threads: [thread('cursor-run', V2, '2026-10-02T00:00:00Z')],
        usage: [
          turn('cursor-run', 1, { agentKind: 'cursor-agent', costUsd: null }),
          turn('cursor-run', 2, { agentKind: 'cursor-agent', costUsd: null }),
          turn('cursor-run', POLLED_SPEND_SEQ, {
            agentKind: 'cursor-agent',
            costUsd: 3,
          }),
          turn('cursor-run', POLLED_SPEND_SEQ - 1, {
            agentKind: 'cursor-agent',
            costUsd: 2,
          }),
        ],
      }),
    );

    expect(result.totals).toMatchObject({ runs: 1, costUsd: 5, avgCostUsd: 5 });
  });

  it('diffs each version against the one numbered before it, and puts copy-less runs in their own row', () => {
    const changesOf = vi.fn(() => CHANGES);
    const result = foldTeamVersions(
      input({
        threads: [
          thread('a', V1, '2026-09-02T00:00:00Z'),
          thread('b', V2, '2026-10-02T00:00:00Z'),
          thread('none', null, '2026-09-01T00:00:00Z'),
        ],
        changesOf,
      }),
    );

    const [second, first] = result.versions;
    expect(second!.changes).toBe(CHANGES);
    expect(first!.changes).toBeNull();
    expect(changesOf).toHaveBeenCalledTimes(1);
    expect(changesOf).toHaveBeenCalledWith(graphs[0], graphs[1]);
    expect(result.unversioned).toMatchObject({
      version: null,
      ordinal: null,
      inferred: false,
      changes: null,
      figures: { runs: 1 },
    });
    expect(result.totals.runs).toBe(3);
    expect(result.currentVersion).toBe(V2);
  });
});

describe('an inferred version, which is never registered', () => {
  it('gets no number or diff and sorts after the numbered versions', () => {
    const result = foldTeamVersions(
      input({
        graphs: [graphs[1]!],
        threads: [
          thread('old', V1, '2026-09-11T00:00:00Z', true),
          thread('new', V2, '2026-10-02T00:00:00Z'),
        ],
      }),
    );

    expect(
      result.versions.map((row) => [row.version, row.ordinal, row.inferred]),
    ).toEqual([
      [V2, 1, false],
      [V1, null, true],
    ]);
    expect(result.versions[0]!.changes).toBeNull();
    expect(result.versions[1]!.changes).toBeNull();
  });
});

describe('a version recorded while teams were node graphs', () => {
  const oldGraph: LegacyTeamGraph = {
    name: 'Dev Team',
    nodes: [
      { id: 'start', kind: 'trigger', trigger: 'manual' },
      { id: 'dev', kind: 'agent', agent: 'claude', approval: 'auto' },
    ],
    edges: [{ from: 'start', to: 'dev', kind: 'data' }],
  };
  const OLD = legacyGraphVersionOf(oldGraph);
  const oldRow = {
    version: OLD,
    graph: legacyCanonicalJson(oldGraph),
    firstSeenAt: new Date('2026-08-01T00:00:00Z'),
  };

  it('is marked preTeam when numbered, and the team-shaped versions after it are not', () => {
    const result = foldTeamVersions(
      input({
        graphs: [oldRow, graphs[0]!],
        currentVersion: V1,
        threads: [
          thread('old', OLD, '2026-08-02T00:00:00Z'),
          thread('new', V1, '2026-09-02T00:00:00Z'),
        ],
      }),
    );

    expect(
      result.versions.map((row) => [row.version, row.ordinal, row.preTeam]),
    ).toEqual([
      [V1, 2, false],
      [OLD, 1, true],
    ]);
  });

  it('is not marked preTeam when no recorded team backs it', () => {
    const result = foldTeamVersions(
      input({
        graphs: [graphs[0]!],
        currentVersion: V1,
        threads: [
          thread('old', OLD, '2026-08-02T00:00:00Z', true),
          thread('new', V1, '2026-09-02T00:00:00Z'),
        ],
      }),
    );

    expect(result.versions.find((row) => row.version === OLD)!.preTeam).toBe(
      false,
    );
  });
});

describe('versions no run has stamped', () => {
  it('keeps a recorded version with no runs as a row, numbered, with no dates', () => {
    const result = foldTeamVersions(
      input({ threads: [thread('a', V1, '2026-09-02T00:00:00Z')] }),
    );

    expect(result.versions[0]).toMatchObject({
      version: V2,
      ordinal: 2,
      inferred: false,
      recorded: true,
      firstRunAt: null,
      lastRunAt: null,
      changes: CHANGES,
      figures: { runs: 0, costUsd: null, avgCostUsd: null },
    });
    expect(result.totals.runs).toBe(1);
  });

  it('shows the library team before its first run, first, diffed against the newest recorded version', () => {
    const v3: Team = { ...v2, maxActiveTurns: 4 };
    const edited = {
      version: teamVersionOf(v3),
      graph: canonicalGraphJson(canonicalGraphOf(v3)),
      firstSeenAt: new Date('2026-10-27T00:00:00Z'),
    };
    const changesOf = vi.fn(() => CHANGES);

    const result = foldTeamVersions(
      input({
        currentVersion: edited.version,
        unrecorded: edited,
        threads: [thread('b', V2, '2026-10-02T00:00:00Z')],
        changesOf,
      }),
    );

    expect(result.versions[0]).toMatchObject({
      version: edited.version,
      ordinal: null,
      recorded: false,
      firstRunAt: null,
      changes: CHANGES,
      figures: { runs: 0 },
    });
    expect(changesOf).toHaveBeenCalledWith(graphs[1], edited);
  });

  it('gives no second row to a library team an inferred version already shows', () => {
    const result = foldTeamVersions(
      input({
        graphs: [],
        currentVersion: V1,
        unrecorded: { ...graphs[0]!, firstSeenAt: new Date() },
        threads: [thread('old', V1, '2026-09-11T00:00:00Z', true)],
      }),
    );

    expect(result.versions.map((row) => row.version)).toEqual([V1]);
    expect(result.versions[0]!.recorded).toBe(true);
  });
});

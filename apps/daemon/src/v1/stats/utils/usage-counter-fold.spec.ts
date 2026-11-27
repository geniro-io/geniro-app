import { describe, expect, it } from 'vitest';

import type { UsageCounterRow, UsageSubjectRow } from '../stats.types';
import { emptyDelta } from './usage-counter-delta';
import {
  foldSubject,
  foldToolUsage,
  removalEligible,
} from './usage-counter-fold';

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 10, 27);
const BOOT = NOW - 60_000;

const geniro = {
  subjectKind: 'tool' as const,
  subject: 'note_thread',
  source: 'geniro',
};

function known(
  daysAgo: number,
  extra: Partial<UsageSubjectRow> = {},
): UsageSubjectRow {
  return {
    ...geniro,
    firstKnownAt: NOW - daysAgo * DAY,
    lastKnownAt: BOOT,
    ...extra,
  };
}

function row(extra: Partial<UsageCounterRow>): UsageCounterRow {
  return {
    ...geniro,
    agentKind: 'claude',
    origin: 'direct',
    projectId: '',
    ...emptyDelta(),
    ...extra,
  };
}

describe('removalEligible', () => {
  it.each([
    [30, 50, 0, true],
    [29, 50, 0, false],
    [30, 49, 0, false],
    [30, 50, 1, false],
  ])(
    'known %i days, offered %i times, called %i times → %s',
    (days, offered, calls, expected) => {
      expect(
        removalEligible(
          geniro,
          { calls, offeredSessions: offered },
          known(days),
          true,
          NOW,
        ),
      ).toBe(expected);
    },
  );

  it.each([
    [
      'a CLI tool',
      { subjectKind: 'tool' as const, subject: 'Bash', source: '' },
    ],
    [
      'another MCP server tool',
      { subjectKind: 'tool' as const, subject: 'x', source: 'codegraph' },
    ],
    [
      'a capability',
      { subjectKind: 'capability' as const, subject: 'compaction', source: '' },
    ],
  ])('never qualifies %s', (_label, subject) => {
    expect(
      removalEligible(
        subject,
        { calls: 0, offeredSessions: 500 },
        { ...known(400), ...subject },
        true,
        NOW,
      ),
    ).toBe(false);
  });

  it('never qualifies a tool this build no longer has', () => {
    expect(
      removalEligible(
        geniro,
        { calls: 0, offeredSessions: 500 },
        known(400),
        false,
        NOW,
      ),
    ).toBe(false);
  });
});

describe('foldToolUsage', () => {
  it('sums each subject over agent, origin and project, and averages only measured calls', () => {
    const fold = foldToolUsage({
      rows: [
        row({
          subject: 'Read',
          source: '',
          calls: 3,
          errors: 1,
          durationMsTotal: 300,
          timedCalls: 2,
          firstAt: 5,
          lastAt: 9,
        }),
        row({
          subject: 'Read',
          source: '',
          origin: 'subagent',
          agentKind: 'codex',
          projectId: 'p1',
          calls: 2,
          resultCharsTotal: 80,
          sizedCalls: 2,
          firstAt: 1,
          lastAt: 7,
        }),
      ],
      subjects: [],
      bootAt: BOOT,
      now: NOW,
    });

    expect(fold.rows).toEqual([
      expect.objectContaining({
        subject: 'Read',
        calls: 5,
        subagentCalls: 2,
        errors: 1,
        avgDurationMs: 150,
        avgResultChars: 40,
        firstAt: new Date(1).toISOString(),
        lastAt: new Date(9).toISOString(),
        offeredSessions: null,
        firstKnownAt: null,
      }),
    ]);
    expect(fold.oldestUse).toBe(1);
  });

  it('lists a registered subject with no call as never called, offers and age included, and leaves out a retired one', () => {
    const fold = foldToolUsage({
      rows: [row({ offeredSessions: 60 })],
      subjects: [
        known(45),
        {
          subjectKind: 'capability',
          subject: 'compaction',
          source: '',
          firstKnownAt: NOW,
          lastKnownAt: BOOT,
        },
        {
          subjectKind: 'tool',
          subject: 'retired_tool',
          source: 'geniro',
          firstKnownAt: 0,
          lastKnownAt: BOOT - DAY,
        },
      ],
      bootAt: BOOT,
      now: NOW,
    });

    expect(fold.rows).toEqual([]);
    expect(
      fold.neverCalled.map((entry) => [
        entry.subject,
        entry.calls,
        entry.offeredSessions,
        entry.removalEligible,
      ]),
    ).toEqual([
      ['compaction', 0, null, false],
      ['note_thread', 0, 60, true],
    ]);
  });
});

describe('foldSubject', () => {
  it('splits one subject by agent, origin and project, naming each project and none for a deleted one', () => {
    const subject = foldSubject({
      subject: { subjectKind: 'tool', subject: 'Read', source: '' },
      rows: [
        row({
          subject: 'Read',
          source: '',
          projectId: 'p1',
          calls: 4,
          errors: 1,
        }),
        row({
          subject: 'Read',
          source: '',
          projectId: 'gone',
          agentKind: 'codex',
          origin: 'subagent',
          calls: 1,
        }),
      ],
      known: undefined,
      bootAt: BOOT,
      now: NOW,
      projectNames: new Map([['p1', 'Geniro']]),
    });

    expect(subject.row).toMatchObject({
      calls: 5,
      subagentCalls: 1,
      errors: 1,
    });
    expect(subject.byAgent).toEqual([
      { agentKind: 'claude', calls: 4, errors: 1 },
      { agentKind: 'codex', calls: 1, errors: 0 },
    ]);
    expect(subject.byOrigin).toEqual([
      { origin: 'direct', calls: 4, errors: 1 },
      { origin: 'subagent', calls: 1, errors: 0 },
    ]);
    expect(subject.byProject).toEqual([
      { projectId: 'p1', name: 'Geniro', calls: 4, errors: 1 },
      { projectId: 'gone', name: null, calls: 1, errors: 0 },
    ]);
  });
});

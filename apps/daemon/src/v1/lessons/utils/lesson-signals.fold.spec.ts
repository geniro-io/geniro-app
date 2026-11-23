import { describe, expect, it } from 'vitest';

import {
  foldLessonSignals,
  type LessonSignalGoal,
  type LessonSignalItem,
} from './lesson-signals.fold';

const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 12, minute));

function item(
  seq: number,
  kind: LessonSignalItem['kind'],
  payload: Record<string, unknown>,
  role: string | null = null,
): LessonSignalItem {
  return {
    seq,
    kind,
    role,
    payload: JSON.stringify(payload),
    createdAt: at(seq),
  };
}

function goal(
  number: number,
  status: LessonSignalGoal['status'],
  closedMinute: number | null,
  evidence: string | null = 'checked',
): LessonSignalGoal {
  return {
    number,
    text: `goal ${number}`,
    status,
    evidence,
    closedAt: closedMinute === null ? null : at(closedMinute),
  };
}

describe('foldLessonSignals', () => {
  it('finds a user correction after the agent finished a turn', () => {
    const signals = foldLessonSignals([
      item(1, 'message', { text: 'run the tests' }, 'user'),
      item(2, 'message', { text: 'Done, all green.' }, 'assistant'),
      item(3, 'turn_complete', {}),
      item(
        4,
        'message',
        { text: 'No — only through pnpm --filter, plain vitest crashes' },
        'user',
      ),
    ]);

    expect(signals).toEqual([
      {
        kind: 'user_correction',
        seq: 4,
        excerpt: 'No — only through pnpm --filter, plain vitest crashes',
      },
    ]);
  });

  it('reads a Russian push-back as a correction', () => {
    const signals = foldLessonSignals([
      item(1, 'turn_complete', {}),
      item(2, 'message', { text: 'не запускай vitest напрямую' }, 'user'),
    ]);

    expect(signals.map((signal) => signal.kind)).toEqual(['user_correction']);
  });

  it('does not count a user message that only continues the work', () => {
    const signals = foldLessonSignals([
      item(1, 'turn_complete', {}),
      item(2, 'message', { text: 'great, now add the README section' }, 'user'),
    ]);

    expect(signals).toEqual([]);
  });

  it('does not count push-back that arrives before the agent finished anything', () => {
    const signals = foldLessonSignals([
      item(1, 'message', { text: 'no, start with the daemon' }, 'user'),
    ]);

    expect(signals).toEqual([]);
  });

  it('counts a correction that opens a stretch after a finished turn, when told the stretch follows one', () => {
    const items = [item(7, 'message', { text: 'No, that is wrong' }, 'user')];

    expect(foldLessonSignals(items)).toEqual([]);
    expect(foldLessonSignals(items, { afterFinishedTurn: true })).toEqual([
      { kind: 'user_correction', seq: 7, excerpt: 'No, that is wrong' },
    ]);
  });

  it('ignores a host-started turn, which is a system row, not a user message', () => {
    const signals = foldLessonSignals([
      item(1, 'turn_complete', {}),
      item(2, 'system', { text: 'no output for 5 minutes' }),
    ]);

    expect(signals).toEqual([]);
  });

  it('finds an error then success of the same tool, at the failure', () => {
    const signals = foldLessonSignals([
      item(1, 'tool_result', {
        name: 'Bash',
        isError: true,
        result: 'better-sqlite3 was compiled against a different Node.js',
      }),
      item(2, 'tool_result', { name: 'Read', isError: false, result: 'x' }),
      item(3, 'tool_result', { name: 'Bash', isError: false, result: 'ok' }),
    ]);

    expect(signals).toEqual([
      {
        kind: 'error_then_success',
        seq: 1,
        excerpt:
          'Bash: better-sqlite3 was compiled against a different Node.js',
      },
    ]);
  });

  it('does not count an error that never recovered', () => {
    const signals = foldLessonSignals([
      item(1, 'tool_result', { name: 'Bash', isError: true, result: 'boom' }),
      item(2, 'tool_result', { name: 'Read', isError: false, result: 'x' }),
    ]);

    expect(signals).toEqual([]);
  });

  it('finds an error then success of a claude tool, whose results carry no name and whose calls do', () => {
    const signals = foldLessonSignals([
      item(1, 'tool_call', { id: 't1', name: 'Bash', input: {} }),
      item(2, 'tool_result', {
        id: 't1',
        name: null,
        isError: true,
        result: 'boom',
      }),
      item(3, 'tool_call', { id: 't2', name: 'Bash', input: {} }),
      item(4, 'tool_result', {
        id: 't2',
        name: null,
        isError: false,
        result: 'ok',
      }),
    ]);

    expect(signals).toEqual([
      { kind: 'error_then_success', seq: 2, excerpt: 'Bash: boom' },
    ]);
  });

  it('does not count a claude error whose tool never succeeded after it', () => {
    const signals = foldLessonSignals([
      item(1, 'tool_call', { id: 't1', name: 'Bash', input: {} }),
      item(2, 'tool_result', {
        id: 't1',
        name: null,
        isError: true,
        result: 'boom',
      }),
      item(3, 'tool_call', { id: 't2', name: 'Read', input: {} }),
      item(4, 'tool_result', {
        id: 't2',
        name: null,
        isError: false,
        result: 'x',
      }),
    ]);

    expect(signals).toEqual([]);
  });

  it('skips a name-less result whose call is not in the stretch', () => {
    const signals = foldLessonSignals([
      item(1, 'tool_result', {
        id: 't1',
        name: null,
        isError: true,
        result: 'boom',
      }),
      item(2, 'tool_call', { id: 't2', name: 'Bash', input: {} }),
      item(3, 'tool_result', {
        id: 't2',
        name: null,
        isError: false,
        result: 'ok',
      }),
    ]);

    expect(signals).toEqual([]);
  });

  it('reads the name a result carries itself over the name of its call', () => {
    const signals = foldLessonSignals([
      item(1, 'tool_call', { id: 't1', name: 'Read', input: {} }),
      item(2, 'tool_result', {
        id: 't1',
        name: 'Bash',
        isError: true,
        result: 'boom',
      }),
      item(3, 'tool_result', {
        id: 't2',
        name: 'Bash',
        isError: false,
        result: 'ok',
      }),
    ]);

    expect(signals).toEqual([
      { kind: 'error_then_success', seq: 2, excerpt: 'Bash: boom' },
    ]);
  });

  it('finds a declined approval, a failed outcome, a reopened stage and review findings', () => {
    const signals = foldLessonSignals([
      item(1, 'approval_verdict', { id: 'a', allow: false }),
      item(2, 'approval_verdict', { id: 'b', allow: true }),
      item(3, 'thread_outcome', { kind: 'partial', summary: 'one PR open' }),
      item(4, 'thread_outcome', { kind: 'success', summary: 'merged' }),
      item(5, 'stage_change', {
        action: 'reopen',
        stageTitle: 'Build',
        text: 'tests failed',
      }),
      item(6, 'stage_change', { action: 'complete', stageTitle: 'Build' }),
      item(7, 'report_findings', { findings: [{}, {}] }),
    ]);

    expect(signals.map(({ kind, seq }) => ({ kind, seq }))).toEqual([
      { kind: 'approval_refused', seq: 1 },
      { kind: 'outcome_failed', seq: 3 },
      { kind: 'stage_reopened', seq: 5 },
      { kind: 'review_finding', seq: 7 },
    ]);
  });

  it('returns nothing for a clean segment and survives a payload that is not JSON', () => {
    const signals = foldLessonSignals([
      item(1, 'message', { text: 'add a button' }, 'user'),
      {
        seq: 2,
        kind: 'tool_result',
        role: null,
        payload: 'not json',
        createdAt: at(2),
      },
      item(3, 'turn_complete', {}),
    ]);

    expect(signals).toEqual([]);
  });

  it('finds a pitfall team note and passes over notes of other kinds', () => {
    const signals = foldLessonSignals([
      item(1, 'team_note', {
        kind: 'pitfall',
        text: 'pnpm install alone leaves better-sqlite3 on the wrong ABI; run rebuild:native',
        nodeId: 'dev',
        conversationId: null,
      }),
      item(2, 'team_note', {
        kind: 'decision',
        text: 'keep one shared helper',
        nodeId: 'dev',
        conversationId: null,
      }),
    ]);

    expect(signals).toEqual([
      {
        kind: 'pitfall_note',
        seq: 1,
        excerpt:
          'pnpm install alone leaves better-sqlite3 on the wrong ABI; run rebuild:native',
      },
    ]);
  });

  it('places each goal closed not achieved or dropped at the newest item written by then', () => {
    const items = [
      item(1, 'message', { text: 'ship it' }, 'user'),
      item(3, 'tool_call', { id: 't1', name: 'goals', input: {} }),
      item(5, 'turn_complete', {}),
    ];

    const signals = foldLessonSignals(items, {
      goals: [
        goal(1, 'not_achieved', 4, 'tests still red'),
        goal(2, 'dropped', 9, null),
        goal(3, 'achieved', 4),
        goal(4, 'open', null),
      ],
    });

    expect(signals).toEqual([
      {
        kind: 'goal_unmet',
        seq: 3,
        excerpt: 'not_achieved g1: goal 1 — tests still red',
      },
      { kind: 'goal_unmet', seq: 5, excerpt: 'dropped g2: goal 2' },
    ]);
  });

  it('leaves a goal closed once the row after the stretch was written to the stretch after it', () => {
    const items = [item(1, 'turn_complete', {})];
    const goals = [goal(1, 'not_achieved', 6), goal(2, 'dropped', 4)];

    expect(
      foldLessonSignals(items, { goals, nextRowAt: at(6) }).map(
        (signal) => signal.excerpt,
      ),
    ).toEqual(['dropped g2: goal 2 — checked']);
  });

  it('leaves a goal closed before the stretch to the stretch before it', () => {
    const items = [item(10, 'turn_complete', {})];
    const goals = [goal(1, 'not_achieved', 2)];

    expect(
      foldLessonSignals(items, { goals, afterEarlierStretch: true }),
    ).toEqual([]);
    expect(foldLessonSignals(items, { goals })).toEqual([
      {
        kind: 'goal_unmet',
        seq: 10,
        excerpt: 'not_achieved g1: goal 1 — checked',
      },
    ]);
    expect(foldLessonSignals([], { goals })).toEqual([]);
  });

  it('cuts a long excerpt to 200 characters', () => {
    const [signal] = foldLessonSignals([
      item(1, 'turn_complete', {}),
      item(2, 'message', { text: `no ${'x'.repeat(400)}` }, 'user'),
    ]);

    expect([...signal!.excerpt]).toHaveLength(200);
    expect(signal!.excerpt.endsWith('…')).toBe(true);
  });
});

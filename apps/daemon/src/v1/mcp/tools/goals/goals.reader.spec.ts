import { describe, expect, it } from 'vitest';

import { goalsListText, goalsResultText, readGoals } from './goals.reader';

describe('readGoals', () => {
  it('reads each action into its call', () => {
    expect(readGoals({ action: 'list' })).toEqual({ action: 'list' });
    expect(
      readGoals({
        action: 'set',
        goals: [{ text: '  ship it ', source: 'user' }],
      }),
    ).toEqual({ action: 'set', goals: [{ text: 'ship it', source: 'user' }] });
    expect(readGoals({ action: 'update', id: 'g2', text: 'b' })).toEqual({
      action: 'update',
      id: 'g2',
      text: 'b',
    });
    expect(
      readGoals({
        action: 'complete',
        id: 'g1',
        status: 'not_achieved',
        evidence: ' tests red ',
      }),
    ).toEqual({
      action: 'complete',
      id: 'g1',
      status: 'not_achieved',
      evidence: 'tests red',
    });
    expect(readGoals({ action: 'reopen', id: 'g1' })).toEqual({
      action: 'reopen',
      id: 'g1',
    });
  });

  it('refuses what an action lacks, a blank evidence and unknown arguments', () => {
    const error = (args: Record<string, unknown>): string => {
      const read = readGoals(args);
      if (!('error' in read)) {
        throw new Error(`expected a refusal for ${JSON.stringify(args)}`);
      }
      return read.error;
    };
    expect(error({ action: 'set' })).toContain('set needs "goals"');
    expect(error({ action: 'remove' })).toContain('remove needs "id"');
    expect(error({ action: 'reopen' })).toContain('reopen needs "id"');
    expect(error({ action: 'update', id: 'g1' })).toContain('update needs');
    expect(
      error({
        action: 'complete',
        id: 'g1',
        status: 'achieved',
        evidence: '  ',
      }),
    ).toContain('complete needs "evidence"');
    expect(error({ action: 'complete', id: 'g1', evidence: 'x' })).toContain(
      'status',
    );
    expect(
      error({ action: 'set', goals: [{ text: 'x', source: 'boss' }] }),
    ).toContain('source');
    expect(error({ action: 'list', run_id: 'r' })).toContain('run_id');
  });
});

describe('goalsResultText', () => {
  it('names what changed and lists the goals after it', () => {
    const goal = {
      id: 'g1',
      text: 'a',
      source: 'agent' as const,
      status: 'achieved' as const,
      evidence: 'ran',
      memberId: null,
      createdAt: '2026-11-01T00:00:00.000Z',
      closedAt: '2026-11-01T00:01:00.000Z',
    };
    expect(
      goalsResultText('complete', {
        status: 'ok',
        goals: [goal],
        changed: [goal],
      }),
    ).toEqual({
      text: 'Closed g1 as achieved.\n1 goal, 0 open:\n- g1 [achieved] a — evidence: ran',
      isError: false,
    });
    expect(
      goalsResultText('add', {
        status: 'refused',
        code: 'TOO_MANY_GOALS',
        reason: 'too many',
      }),
    ).toEqual({
      text: 'Not changed (TOO_MANY_GOALS): too many.',
      isError: true,
    });
    expect(goalsListText([])).toContain('no goals yet');
  });
});

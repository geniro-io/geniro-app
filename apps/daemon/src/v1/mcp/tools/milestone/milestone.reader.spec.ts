import { describe, expect, it } from 'vitest';

import { MILESTONE_TEXT_MAX_CHARS } from '../../../agents/chat.types';
import { milestoneResultText, readMilestone } from './milestone.reader';

describe('readMilestone', () => {
  it('reads a step onto one line, kind progress by default', () => {
    expect(readMilestone({ text: '  Found\nthe   cause ' })).toEqual({
      text: 'Found the cause',
      kind: 'progress',
    });
  });

  it('keeps the kind given', () => {
    expect(readMilestone({ text: 'Tests pass', kind: 'done' })).toMatchObject({
      kind: 'done',
    });
    expect(
      readMilestone({ text: 'Race in the queue', kind: 'problem' }),
    ).toMatchObject({
      kind: 'problem',
    });
  });

  it('cuts a long step to the limit on code points, never splitting an emoji', () => {
    const read = readMilestone({
      text: '🚀'.repeat(MILESTONE_TEXT_MAX_CHARS + 20),
    });
    expect('text' in read && [...read.text]).toHaveLength(
      MILESTONE_TEXT_MAX_CHARS,
    );
    expect('text' in read && read.text.endsWith('…')).toBe(true);
  });

  it('refuses an empty step, an unknown kind, a hidden character and unknown arguments', () => {
    expect(readMilestone({ text: '   ' })).toHaveProperty('error');
    expect(readMilestone({ text: 'x', kind: 'finished' })).toHaveProperty(
      'error',
    );
    expect(readMilestone({ text: 'a‮b' })).toHaveProperty('error');
    expect(readMilestone({ text: 'x', summary: 'y' })).toHaveProperty('error');
  });
});

describe('milestoneResultText', () => {
  it('words each outcome', () => {
    expect(milestoneResultText({ status: 'recorded', seq: 12 })).toBe(
      'Step recorded (12).',
    );
    expect(milestoneResultText({ status: 'unchanged', seq: 9 })).toMatch(
      /^Unchanged: step 9/,
    );
    expect(
      milestoneResultText({ status: 'unavailable', reason: 'no turn' }),
    ).toBe('Not recorded: no turn.');
  });
});

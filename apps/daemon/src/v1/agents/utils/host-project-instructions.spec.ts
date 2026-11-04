import { describe, expect, it } from 'vitest';

import { HOST_PROJECT_INSTRUCTIONS_TOOL } from '../chat.types';
import {
  instructionsDiff,
  isHostProjectInstructionsCall,
  projectInstructionsCardInput,
  projectInstructionsVerdict,
  readHostProjectInstructions,
} from './host-project-instructions';

const SERVER = 'geniro-1a2b3c4d';

describe('isHostProjectInstructionsCall', () => {
  it('matches this run’s server only', () => {
    expect(
      isHostProjectInstructionsCall(
        SERVER,
        `mcp__${SERVER}__${HOST_PROJECT_INSTRUCTIONS_TOOL}`,
      ),
    ).toBe(true);
    expect(
      isHostProjectInstructionsCall(
        SERVER,
        `mcp__acme__${HOST_PROJECT_INSTRUCTIONS_TOOL}`,
      ),
    ).toBe(false);
    expect(
      isHostProjectInstructionsCall(
        null,
        `mcp__${SERVER}__${HOST_PROJECT_INSTRUCTIONS_TOOL}`,
      ),
    ).toBe(false);
  });
});

describe('projectInstructionsCardInput', () => {
  it('spells the old and new text the way the diff reads them, leaving out an old text there was none of', () => {
    const change = {
      projectId: 'p-billing',
      project: 'Billing',
      previous: null,
      next: 'Use pnpm.',
      blocks: [{ id: 'b1', title: '', text: 'Use pnpm.' }],
      baseRevision: 0,
      ids: ['P-1'],
      cardSeq: 4,
    };
    expect(projectInstructionsCardInput(change)).toEqual({
      summary: 'Change the instructions of project Billing',
      projectId: 'p-billing',
      project: 'Billing',
      diff: '@@ -0,0 +1,1 @@\n+Use pnpm.',
      new_string: 'Use pnpm.',
      ids: ['P-1'],
    });
    expect(
      projectInstructionsCardInput({
        ...change,
        previous: 'Use pnpm.',
        next: null,
      }),
    ).toMatchObject({ old_string: 'Use pnpm.', new_string: '' });
  });
});

describe('instructionsDiff', () => {
  it('shows the changed lines with three lines of context, not the whole text', () => {
    const lines = Array.from(
      { length: 12 },
      (_, index) => `Rule ${index + 1}.`,
    );
    const previous = lines.join('\n');
    const next = lines
      .map((line) => (line === 'Rule 8.' ? 'Rule 8, revised.' : line))
      .join('\n');

    expect(instructionsDiff(previous, next).split('\n')).toEqual([
      '@@ -5,7 +5,7 @@',
      ' Rule 5.',
      ' Rule 6.',
      ' Rule 7.',
      '-Rule 8.',
      '+Rule 8, revised.',
      ' Rule 9.',
      ' Rule 10.',
      ' Rule 11.',
    ]);
    expect(instructionsDiff('Same.', 'Same.')).toBe('');
  });
});

describe('projectInstructionsVerdict', () => {
  it('records whether Apply saved, with the revision or the reason', () => {
    expect(
      projectInstructionsVerdict({ status: 'saved', instructionsRevision: 4 }),
    ).toEqual({ outcome: 'saved', answer: 'saved as revision 4' });
    expect(
      projectInstructionsVerdict({
        status: 'stale',
        reason: 'the project has been deleted',
      }),
    ).toEqual({ outcome: 'not-saved', answer: 'the project has been deleted' });
    expect(projectInstructionsVerdict({ status: 'declined' })).toEqual({});
  });
});

describe('readHostProjectInstructions', () => {
  const stored = {
    projectId: 'p1',
    project: 'Billing',
    previous: 'Use pnpm.',
    next: 'Use pnpm only.',
    blocks: [{ id: 'b1', title: '', text: 'Use pnpm only.' }],
    baseRevision: 2,
  };

  it('reads an analysis’s card with its items and a project chat’s with none', () => {
    expect(
      readHostProjectInstructions({ ...stored, ids: ['P-1'], cardSeq: 4 }),
    ).toMatchObject({ ids: ['P-1'], cardSeq: 4 });
    expect(
      readHostProjectInstructions({ ...stored, ids: [], cardSeq: null }),
    ).toMatchObject({ ids: [], cardSeq: null });
  });

  it('refuses items without a card, and a card without items', () => {
    expect(
      readHostProjectInstructions({ ...stored, ids: ['P-1'], cardSeq: null }),
    ).toBeNull();
    expect(
      readHostProjectInstructions({ ...stored, ids: [], cardSeq: 4 }),
    ).toBeNull();
  });
});

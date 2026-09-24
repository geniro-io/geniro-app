import { describe, expect, it } from 'vitest';

import { aLabelInstruction } from '../__tests__/fixtures';
import { composeLabelInstructions } from './label-instructions-prompt';

describe('composeLabelInstructions', () => {
  it('answers null when no rows attach — the "nothing to add" reading', () => {
    expect(composeLabelInstructions([])).toBeNull();
  });

  it('renders one block per row under a heading naming its label', () => {
    const text = composeLabelInstructions([aLabelInstruction()]);

    expect(text).toContain(`Instructions attached to this task's labels:`);
    expect(text).toContain('## Label "bug"');
    expect(text).toContain('Write a regression test.');
  });

  it('marks a project-scoped row and leaves a global row unmarked', () => {
    const text = composeLabelInstructions([
      aLabelInstruction({ label: 'bug', projectId: null }),
      aLabelInstruction({ label: 'frontend', projectId: 'proj-1' }),
    ]);

    // Exact headings, so a project row losing its marker (or a global row
    // gaining one it shouldn't) fails this rather than a looser `.toContain`
    // on the label name alone.
    expect(text).toContain('## Label "bug"\n');
    expect(text).toContain('## Label "frontend" (project)\n');
  });

  it('joins several rows into one block, in the order given', () => {
    const text = composeLabelInstructions([
      aLabelInstruction({ label: 'bug', instructions: 'first' }),
      aLabelInstruction({
        label: 'frontend',
        projectId: 'proj-1',
        instructions: 'second',
      }),
    ]);

    const bugIndex = text?.indexOf('## Label "bug"') ?? -1;
    const frontendIndex = text?.indexOf('## Label "frontend"') ?? -1;
    expect(bugIndex).toBeGreaterThanOrEqual(0);
    expect(frontendIndex).toBeGreaterThan(bugIndex);
  });

  it('sends every row whole, however long — there is no length limit', () => {
    // Two rows each past the old 16,000-character cap, whose join would have
    // been cut down to fit it: both must arrive intact.
    const huge = 'x'.repeat(20_000);
    const text = composeLabelInstructions([
      aLabelInstruction({ label: 'huge-one', instructions: huge }),
      aLabelInstruction({ label: 'huge-two', instructions: huge }),
      aLabelInstruction({ label: 'short', instructions: 'fits fine' }),
    ]);

    expect(text).toBe(
      `Instructions attached to this task's labels:\n\n` +
        `## Label "huge-one"\n${huge}\n\n` +
        `## Label "huge-two"\n${huge}\n\n` +
        `## Label "short"\nfits fine`,
    );
  });
});

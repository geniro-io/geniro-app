import { describe, expect, it } from 'vitest';

import { MAX_CUSTOM_INSTRUCTIONS_CHARS } from '../../agents/chat.types';
import { aLabelInstruction } from '../__tests__/fixtures';
import { composeLabelInstructions } from './label-instructions-prompt';

describe('composeLabelInstructions', () => {
  it('answers a null text and no omissions when no rows attach — the "nothing to add" reading', () => {
    expect(composeLabelInstructions([])).toEqual({ text: null, omitted: [] });
  });

  it('renders one block per row under a heading naming its label', () => {
    const { text } = composeLabelInstructions([aLabelInstruction()]);

    expect(text).toContain(`Instructions attached to this task's labels:`);
    expect(text).toContain('## Label "bug"');
    expect(text).toContain('Write a regression test.');
  });

  it('marks a project-scoped row and leaves a global row unmarked', () => {
    const { text } = composeLabelInstructions([
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
    const { text } = composeLabelInstructions([
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

  it('omits a whole section that would overflow the budget, still includes a later short one, and notes the omission in the text', () => {
    const huge = 'x'.repeat(MAX_CUSTOM_INSTRUCTIONS_CHARS);
    const result = composeLabelInstructions([
      aLabelInstruction({ label: 'huge-one', instructions: huge }),
      aLabelInstruction({ label: 'huge-two', instructions: huge }),
      aLabelInstruction({ label: 'short', instructions: 'fits fine' }),
    ]);

    // Named whole, never a truncated fragment of either — the labels appear
    // only in the trailing note, never as a `## Label "…"` section.
    expect(result.omitted).toEqual(['huge-one', 'huge-two']);
    expect(result.text).toContain('## Label "short"');
    expect(result.text).not.toContain('## Label "huge-one"');
    expect(result.text).not.toContain('## Label "huge-two"');
    // The agent must be told what was left out, not only the log.
    expect(result.text).toContain('(Left out for length: huge-one, huge-two.)');
    expect(result.text?.length).toBeLessThanOrEqual(
      MAX_CUSTOM_INSTRUCTIONS_CHARS,
    );
  });

  it('answers the header plus the note when every row overflows, rather than a bare null', () => {
    const huge = 'x'.repeat(MAX_CUSTOM_INSTRUCTIONS_CHARS);
    const result = composeLabelInstructions([
      aLabelInstruction({ label: 'huge-one', instructions: huge }),
    ]);

    expect(result.text).toBe(
      `Instructions attached to this task's labels:\n\n(Left out for length: huge-one.)`,
    );
    expect(result.omitted).toEqual(['huge-one']);
  });
});

import { describe, expect, it } from 'vitest';

import {
  createLabelInstructionSchema,
  updateLabelInstructionSchema,
} from './label-instruction.dto';

/**
 * A label with instructions is written into the composed instructions a task
 * run hands its CLI as argv, where a control character makes the spawn throw
 * on every turn — so the label is held to the instructions' own refusal.
 */
describe('label instruction DTOs', () => {
  it('refuses a label carrying a control character on create', () => {
    const parsed = createLabelInstructionSchema.safeParse({
      label: 'bug\u0000',
      instructions: 'Write a failing test first.',
    });

    expect(parsed.success).toBe(false);
  });

  it('refuses a label carrying a control character on update', () => {
    const parsed = updateLabelInstructionSchema.safeParse({
      label: 'ui\u001b[31m',
    });

    expect(parsed.success).toBe(false);
  });

  it('refuses a label carrying a newline, even though CustomInstructionsSchema admits one', () => {
    const parsed = createLabelInstructionSchema.safeParse({
      label: 'multi\nline',
      instructions: 'Write a failing test first.',
    });

    expect(parsed.success).toBe(false);
  });

  it('refuses a label carrying a carriage return', () => {
    const parsed = createLabelInstructionSchema.safeParse({
      label: 'multi\rline',
      instructions: 'Write a failing test first.',
    });

    expect(parsed.success).toBe(false);
  });

  it('refuses a label carrying a tab', () => {
    const parsed = createLabelInstructionSchema.safeParse({
      label: 'has\ttab',
      instructions: 'Write a failing test first.',
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts an ordinary label and instructions', () => {
    const parsed = createLabelInstructionSchema.safeParse({
      label: 'frontend',
      projectId: null,
      instructions: 'Check it in a narrow window.',
    });

    expect(parsed.success).toBe(true);
  });
});

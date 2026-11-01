import { describe, expect, it } from 'vitest';

import { projectInstructionsText } from './project-instructions';

describe('projectInstructionsText', () => {
  it('is null when both description and instructions are blank', () => {
    expect(
      projectInstructionsText({
        name: 'Billing',
        description: null,
        instructions: null,
      }),
    ).toBeNull();
    expect(
      projectInstructionsText({
        name: 'Billing',
        description: '  ',
        instructions: '\n',
      }),
    ).toBeNull();
  });

  it('writes the name, the description and the instructions as paragraphs', () => {
    expect(
      projectInstructionsText({
        name: 'Billing',
        description: '  The invoicing service.  ',
        instructions: '\nUse pnpm.\nNever touch /legacy.\n',
      }),
    ).toBe(
      'Project: Billing\n\nThe invoicing service.\n\nUse pnpm.\nNever touch /legacy.',
    );
  });

  it('drops control characters from a name saved before names refused them', () => {
    expect(
      projectInstructionsText({
        name: `Bil${String.fromCharCode(0)}ling`,
        description: 'The invoicing service.',
        instructions: null,
      }),
    ).toBe('Project: Billing\n\nThe invoicing service.');
  });

  it('omits the paragraph of whichever field is blank', () => {
    expect(
      projectInstructionsText({
        name: 'Billing',
        description: 'The invoicing service.',
        instructions: null,
      }),
    ).toBe('Project: Billing\n\nThe invoicing service.');
    expect(
      projectInstructionsText({
        name: 'Billing',
        description: ' ',
        instructions: 'Use pnpm.',
      }),
    ).toBe('Project: Billing\n\nUse pnpm.');
  });
});

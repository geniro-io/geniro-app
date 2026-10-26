import { describe, expect, it } from 'vitest';

import {
  readRemoveAction,
  removeActionResultText,
} from './remove-action.reader';

describe('readRemoveAction', () => {
  it('reads the id, trimmed', () => {
    expect(readRemoveAction({ action_id: ' pr-merged ' })).toBe('pr-merged');
  });

  it('refuses a blank id and an unknown argument', () => {
    expect(readRemoveAction({ action_id: '  ' })).toEqual({
      error: expect.stringContaining('action_id') as string,
    });
    expect(readRemoveAction({ id: 'x' })).toEqual({
      error: expect.stringContaining('"id"') as string,
    });
  });
});

describe('removeActionResultText', () => {
  it('words an unavailable channel and passes a receipt through', () => {
    expect(
      removeActionResultText({
        status: 'unavailable',
        reason: 'no turn is running',
      }),
    ).toBe('Not removed: no turn is running.');
    expect(
      removeActionResultText({ status: 'removed', text: 'Removed.' }),
    ).toBe('Removed.');
  });
});

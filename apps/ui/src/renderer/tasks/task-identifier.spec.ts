import { describe, expect, it } from 'vitest';

import { taskIdentifier } from './task-identifier';

describe('taskIdentifier', () => {
  it('joins the two halves the one way every surface draws them', () => {
    expect(taskIdentifier('GEN', 12)).toBe('GEN-12');
  });

  it('draws nothing for a card the backfill has not reached', () => {
    // `GEN-0` names a card that does not exist and a bare `-12` names no
    // board, so the absence is the honest answer. The two halves arrive on
    // different rows, which is why both have to be checked here.
    expect(taskIdentifier('GEN', null)).toBeNull();
    expect(taskIdentifier('GEN', 0)).toBeNull();
    expect(taskIdentifier(null, 12)).toBeNull();
    expect(taskIdentifier('', 12)).toBeNull();
    expect(taskIdentifier(undefined, undefined)).toBeNull();
  });
});

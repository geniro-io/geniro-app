import { describe, expect, it } from 'vitest';

import { isWorkFinished } from './work-finished';

describe('isWorkFinished', () => {
  it('is finished once the card is Done and its run has settled', () => {
    expect(isWorkFinished('done', 'completed', false)).toBe(true);
    expect(isWorkFinished('done', 'failed', false)).toBe(true);
    expect(isWorkFinished('done', 'cancelled', false)).toBe(true);
  });

  it('is finished for a Done card with no run left to work in it', () => {
    expect(isWorkFinished('done', null, false)).toBe(true);
  });

  // The column is written the moment a card is dragged, so Done alone says
  // nothing about the agent — collecting here removes a live agent's cwd.
  it('is NOT finished while the run on a Done card is still working', () => {
    expect(isWorkFinished('done', 'running', false)).toBe(false);
    expect(isWorkFinished('done', 'pending', false)).toBe(false);
  });

  it('is NOT finished while a settled run still holds work outside a turn', () => {
    expect(isWorkFinished('done', 'completed', true)).toBe(false);
  });

  // The defect this exists for: a settled run is a chat the user continues
  // after review, so a card in review still needs its worktree.
  it('is NOT finished while the card is anywhere but Done, however its run ended', () => {
    expect(isWorkFinished('in_review', 'completed', false)).toBe(false);
    expect(isWorkFinished('failed', 'failed', false)).toBe(false);
    expect(isWorkFinished('todo', 'cancelled', false)).toBe(false);
    expect(isWorkFinished('in_progress', null, false)).toBe(false);
  });
});

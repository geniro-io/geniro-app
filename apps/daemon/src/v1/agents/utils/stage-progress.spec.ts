import { describe, expect, it } from 'vitest';

import type { StageProgress } from '../chat.types';
import { readRunStageProgress, writeRunStageProgress } from './stage-progress';

const PROGRESS: StageProgress = {
  rev: 1,
  current: 'build',
  position: { index: 2, total: 2 },
  stages: [
    {
      id: 'plan',
      title: 'Plan',
      status: 'done',
      next: ['build'],
      by: { kind: 'system' },
      rev: 1,
    },
    { id: 'build', title: 'Build', status: 'current', next: [] },
  ],
};

describe('readRunStageProgress', () => {
  it('reads a run with no stored progress as none', () => {
    expect(readRunStageProgress(null)).toBeNull();
  });

  it('parses the progress it stored', () => {
    expect(readRunStageProgress(writeRunStageProgress(PROGRESS))).toEqual(
      PROGRESS,
    );
  });

  it('reads a column that is not JSON as none instead of throwing', () => {
    expect(readRunStageProgress('{"rev": 1, "stages": [')).toBeNull();
  });

  it('reads JSON that is not a progress as none', () => {
    expect(readRunStageProgress('{"rev":"one"}')).toBeNull();
    expect(readRunStageProgress('[]')).toBeNull();
    expect(
      readRunStageProgress(
        JSON.stringify({
          ...PROGRESS,
          stages: [{ id: 'plan', title: 'Plan', status: 'finished', next: [] }],
        }),
      ),
    ).toBeNull();
  });
});

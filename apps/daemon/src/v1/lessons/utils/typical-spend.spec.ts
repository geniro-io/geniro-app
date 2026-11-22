import { describe, expect, it } from 'vitest';

import {
  LESSON_TYPICAL_SAMPLE,
  type LessonRunSample,
  typicalSpendOf,
} from './typical-spend';

function run(
  model: string | null,
  usd: number | null,
  durationMs: number | null = 30_000,
): LessonRunSample {
  return { model, usd, durationMs };
}

describe('typicalSpendOf', () => {
  it('is null before any run finished', () => {
    expect(typicalSpendOf([], 'claude-sonnet-5-5')).toBeNull();
  });

  it('takes the median of runs on the same model once there are three of them', () => {
    const samples = [
      run('claude-sonnet-5-5', 0.2, 30_000),
      run('claude-opus-5-5', 0.9, 70_000),
      run('claude-sonnet-5-5', 0.4, 40_000),
      run('claude-sonnet-5-5', 0.3, 50_000),
    ];

    expect(typicalSpendOf(samples, 'claude-sonnet-5-5')).toEqual({
      runs: 3,
      usd: 0.3,
      durationMs: 40_000,
      model: 'claude-sonnet-5-5',
      sameModel: true,
    });
  });

  it('counts runs on every model while fewer than three ran on this one', () => {
    const samples = [
      run('claude-sonnet-5-5', 0.2),
      run('claude-opus-5-5', 0.9),
      run('claude-haiku-5-5', 0.1),
      run('claude-opus-5-5', 1.1),
    ];

    expect(typicalSpendOf(samples, 'claude-sonnet-5-5')).toEqual({
      runs: 4,
      usd: (0.2 + 0.9) / 2,
      durationMs: 30_000,
      model: null,
      sameModel: false,
    });
  });

  it('leaves runs with no reported cost out of the median and never answers 0', () => {
    expect(
      typicalSpendOf([run('a', null), run('a', 0.5), run('a', null)], 'a')?.usd,
    ).toBe(0.5);
    expect(typicalSpendOf([run('a', null), run('b', null)], 'a')).toMatchObject(
      { runs: 2, usd: null },
    );
  });

  it('reads only the newest runs', () => {
    const samples = [
      ...Array.from({ length: LESSON_TYPICAL_SAMPLE }, () => run('a', 0.1)),
      ...Array.from({ length: 10 }, () => run('a', 5)),
    ];

    expect(typicalSpendOf(samples, 'a')).toMatchObject({
      runs: LESSON_TYPICAL_SAMPLE,
      usd: 0.1,
    });
  });
});

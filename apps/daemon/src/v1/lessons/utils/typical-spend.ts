import type { LessonTypicalSpend } from '../lessons.types';

/** How many of the newest finished runs the typical figures are taken over. */
export const LESSON_TYPICAL_SAMPLE = 20;
/** How many runs on the same model it takes before only those are counted. */
export const LESSON_TYPICAL_SAME_MODEL_MIN = 3;

/** One finished run as the typical figures read it. */
export interface LessonRunSample {
  model: string | null;
  usd: number | null;
  durationMs: number | null;
}

/**
 * What a lessons run typically costs and takes, from runs already finished,
 * newest first: the median spend and time of the newest
 * {@link LESSON_TYPICAL_SAMPLE}, only those on `model` when there are enough of
 * them. A run whose CLI reported no cost or time is left out of that median,
 * so a figure no run reported is null, never 0.
 */
export function typicalSpendOf(
  samples: readonly LessonRunSample[],
  model: string | null,
): LessonTypicalSpend | null {
  const sameModel =
    model === null
      ? []
      : samples
          .filter((sample) => sample.model === model)
          .slice(0, LESSON_TYPICAL_SAMPLE);
  const useSame = sameModel.length >= LESSON_TYPICAL_SAME_MODEL_MIN;
  const picked = useSame ? sameModel : samples.slice(0, LESSON_TYPICAL_SAMPLE);
  if (picked.length === 0) {
    return null;
  }
  return {
    runs: picked.length,
    usd: medianOf(picked.map((sample) => sample.usd)),
    durationMs: medianOf(picked.map((sample) => sample.durationMs)),
    model: useSame ? model : null,
    sameModel: useSame,
  };
}

function medianOf(values: readonly (number | null)[]): number | null {
  const measured = values
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (measured.length === 0) {
    return null;
  }
  const middle = Math.floor(measured.length / 2);
  return measured.length % 2 === 1
    ? measured[middle]!
    : (measured[middle - 1]! + measured[middle]!) / 2;
}

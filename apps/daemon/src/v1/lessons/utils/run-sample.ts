import { sumMeasured } from './sum-measured';
import type { LessonRunSample } from './typical-spend';

/** One usage-ledger row as a lessons run's figures read it. */
export interface LessonLedgerRow {
  model: string | null;
  costUsd: number | null;
  durationMs: number | null;
}

/**
 * A lessons run's figures from the ledger rows of its reflection and check:
 * spend and time summed over what was reported (null when nothing was), and
 * the model it was billed for — the one charged most, else the last one named.
 */
export function runSampleOf(rows: readonly LessonLedgerRow[]): LessonRunSample {
  const spent = new Map<string, number>();
  let named: string | null = null;
  for (const row of rows) {
    if (row.model === null) {
      continue;
    }
    named = row.model;
    if (row.costUsd !== null) {
      spent.set(row.model, (spent.get(row.model) ?? 0) + row.costUsd);
    }
  }
  let costliest: string | null = null;
  for (const [model, cost] of spent) {
    if (costliest === null || cost > (spent.get(costliest) ?? 0)) {
      costliest = model;
    }
  }
  return {
    model: costliest ?? named,
    usd: sumMeasured(rows.map((row) => row.costUsd)),
    durationMs: sumMeasured(rows.map((row) => row.durationMs)),
  };
}

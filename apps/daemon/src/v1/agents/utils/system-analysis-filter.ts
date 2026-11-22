import type { Expression, ExpressionBuilder } from 'kysely';

/**
 * The typed-builder twin of `NOT_SYSTEM_ANALYSIS` (`run.dao.ts`): a run that
 * is not the system analysis. NULL-safe — `<>` alone would drop every run of
 * no purpose.
 */
export function notSystemAnalysis<DB, TB extends keyof DB>(
  eb: ExpressionBuilder<DB, TB>,
  purpose: Expression<string | null>,
) {
  return eb.or([eb(purpose, 'is', null), eb(purpose, '!=', 'system')]);
}

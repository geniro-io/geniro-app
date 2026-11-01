import { RunOutcomePayloadSchema } from '../chat.types';

/**
 * A `run_outcome` row's payload read against today's schema. A row recorded
 * before the rename names the run's team `workflowSlug`.
 */
export function parseRunOutcomePayload(
  raw: unknown,
): ReturnType<typeof RunOutcomePayloadSchema.safeParse> {
  if (
    raw !== null &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    !('teamSlug' in raw) &&
    'workflowSlug' in raw
  ) {
    const { workflowSlug, ...outcome } = raw as Record<string, unknown>;
    return RunOutcomePayloadSchema.safeParse({
      ...outcome,
      teamSlug: workflowSlug,
    });
  }
  return RunOutcomePayloadSchema.safeParse(raw);
}

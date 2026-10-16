/**
 * `propose_plan`'s argument reader and result text.
 *
 * They live in `agents/utils/host-plan.ts` (and are tested there) for the
 * reason `propose-patch.reader.ts` gives: a deferred plan card is re-read and
 * answered by the agents module, which may not import `v1/mcp`.
 */
export {
  hostPlanResultText,
  type PlanRead,
  readHostPlan,
} from '../../../agents/utils/host-plan';

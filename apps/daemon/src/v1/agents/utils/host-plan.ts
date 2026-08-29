import {
  HOST_PLAN_TOOL,
  type HostPlan,
  type HostPlanOutcome,
  type HostPlanStep,
  MAX_PLAN_STEP_DETAIL_LENGTH,
  MAX_PLAN_STEP_TITLE_LENGTH,
  MAX_PLAN_STEPS,
  MAX_PLAN_TITLE_LENGTH,
} from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names geniro's OWN plan tool.
 *
 * Auto-approved like every tool in this family, and for the patch tool's exact
 * reason: calling it DOES nothing — it puts a plan on screen with Approve and
 * Reject, and the press is the gate. A permission card in front of that one
 * would ask the user to approve the asking.
 */
export function isHostPlanCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_PLAN_TOOL);
}

/**
 * A read plan, or the sentence saying why it could not be read.
 *
 * A reason rather than a bare null, on the patch reader's rule: every refusal
 * here names something the agent can fix and send again, and "INVALID_ARGS"
 * with nothing after it makes it guess which.
 */
export type PlanRead =
  { ok: true; plan: HostPlan } | { ok: false; reason: string };

/**
 * Read a `propose_plan` call's arguments.
 *
 * Defensive like every host-tool reader, and TRUNCATING like the findings one:
 * an over-long step title is still a step, so it is shortened rather than
 * refused. Only a plan with no readable step at all is refused, because a card
 * with no rows is not a plan the user can answer.
 *
 * A step that is not an object, or whose `title` is not a usable string, is
 * DROPPED rather than kept blank — unlike a chart's missing point, where the
 * blank holds a position. Nothing here is positional, so an unreadable row
 * would only be an empty line the user has to wonder about.
 */
export function readHostPlan(args: Record<string, unknown>): PlanRead {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (title.length === 0) {
    return {
      ok: false,
      reason: "'title' must be a non-empty string saying what the plan is for.",
    };
  }
  if (!Array.isArray(args.steps)) {
    return { ok: false, reason: "'steps' must be an array." };
  }
  const steps: HostPlanStep[] = [];
  for (const entry of args.steps) {
    if (steps.length >= MAX_PLAN_STEPS) {
      break;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const step = entry as { title?: unknown; detail?: unknown };
    if (typeof step.title !== 'string') {
      continue;
    }
    const stepTitle = step.title.trim();
    if (stepTitle.length === 0) {
      continue;
    }
    const detail =
      typeof step.detail === 'string' && step.detail.trim().length > 0
        ? step.detail.trim().slice(0, MAX_PLAN_STEP_DETAIL_LENGTH)
        : undefined;
    steps.push({
      title: stepTitle.slice(0, MAX_PLAN_STEP_TITLE_LENGTH),
      ...(detail === undefined ? {} : { detail }),
    });
  }
  if (steps.length === 0) {
    return {
      ok: false,
      reason:
        "'steps' held no readable step — each entry needs a non-empty 'title' string.",
    };
  }
  return {
    ok: true,
    plan: { title: title.slice(0, MAX_PLAN_TITLE_LENGTH), steps },
  };
}

/**
 * The tool result text for one outcome.
 *
 * Each arm says what happened and what the next move is, because this tool's
 * whole purpose is to change what the agent does next. The note is quoted back
 * INSIDE the sentence rather than appended after it: an approval carrying a
 * caveat must not read as a plain yes, and a refusal carrying a redirection
 * must not read as a wall the agent argues with.
 */
export function hostPlanResultText(outcome: HostPlanOutcome): string {
  switch (outcome.status) {
    case 'approved':
      return outcome.note === undefined
        ? 'The user approved the plan. Carry it out.'
        : `The user approved the plan and added: "${outcome.note}". Carry it out, following that.`;
    case 'declined':
      return outcome.note === undefined
        ? 'The user rejected the plan. Do not carry it out — ask what they would prefer before doing anything else.'
        : `The user rejected the plan and said: "${outcome.note}". Do not carry it out — work from what they said instead.`;
    case 'unavailable':
      return `The plan could not be put to the user (${outcome.reason}). Describe it in your reply and ask there instead.`;
  }
}

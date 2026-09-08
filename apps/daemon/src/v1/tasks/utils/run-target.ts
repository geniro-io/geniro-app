import type { ChatApprovalMode } from '../../agents/chat.types';
import type { AgentKind } from '../../runs/runs.types';
import type {
  RunTargetProblem,
  RunTargetProblemReason,
  RunTargetResolution,
  TaskRunStarter,
} from '../tasks.types';

/**
 * The approval mode an autopilot run is forced to.
 *
 * A mode that can ASK deadlocks an unattended run: no approval request expires
 * — `approval-registry.ts` holds a plain Map with no timer — and a turn's
 * silence deadline is SUSPENDED while it waits on a verdict, so the turn does
 * not time out, it waits forever, holding its slot against the project's cap
 * and its worktree on disk. `auto` is the only mode that runs unattended: the
 * daemon auto-approves plain permission requests at its own seam while still
 * reserving the human card for a genuine question (`ClaudeAdapter.buildArgs`).
 *
 * What arming AUTHORISES is the agent approving its own shell commands. The
 * worktree bounds where the run writes, not what it can do — a command inside
 * one can still read `~/.ssh`, pipe a download into a shell, or delete outside
 * the checkout. The real bounds are that arming is per project and opt-in, the
 * cap limits how many such runs exist at once, and the breaker stops the board
 * after three consecutive failures.
 *
 * Forced HERE rather than trusted to arrive in the request: the resolution
 * below is most-specific-first, so a project pinning `approval: 'ask'` would
 * otherwise outrank the conductor's value and hang every unattended run on
 * that board.
 *
 * TWIN PARSER: `apps/ui/src/main/autopilot-conductor.ts` `AUTOPILOT_APPROVAL`.
 * The conductor runs in the Electron main process, which imports no daemon
 * source (that would pull the Nest graph into the main bundle), so the value
 * is spelled once on each side. THIS copy is the one that ENFORCES it — the
 * override below discards whatever the request carried — and the conductor's
 * is what the request carries. Change one and change the other, or the value
 * a run is started with stops matching the value the log and the arming copy
 * describe.
 */
export const AUTOPILOT_APPROVAL: ChatApprovalMode = 'auto';

/**
 * Why a card that names nothing cannot be run.
 *
 * ONE sentence for both refusals — the start route's exception and the
 * autopilot queue's blocked list — because they are the same fact reaching the
 * user by two roads, and a card the board explains one way while the Run button
 * explains another is the same bug twice. It names both rows because either one
 * fixes it: the card inherits what the project sets.
 */
export const NO_RUN_TARGET_REASON =
  'no agent or workflow — set one on this task, or a default for the project';

/**
 * The sentence for each way a card can be unstartable.
 *
 * One record rather than a branch per caller, for {@link NO_RUN_TARGET_REASON}'s
 * own reason: the start route's exception and the queue's blocked list are the
 * same fact reaching the user by two roads.
 */
export const RUN_TARGET_PROBLEM_REASON: Record<RunTargetProblemReason, string> =
  {
    'no-target': NO_RUN_TARGET_REASON,
    'workflow-unattended':
      'a workflow cannot run unattended — its nodes each carry their own approval mode, and one that asks would park forever; point this task at an agent, or start it yourself',
  };

/**
 * The error code the START route refuses with, per problem.
 *
 * Beside the sentence rather than in the service, so adding a problem is one
 * edit: the conductor logs the CODE (`autopilot-conductor.ts`'s `detailOf`),
 * and a single code for every refusal is what made an unattended loop's log
 * unable to say which card was wrong or why.
 */
export const RUN_TARGET_PROBLEM_CODE: Record<RunTargetProblemReason, string> = {
  'no-target': 'TASK_RUN_NO_AGENT',
  'workflow-unattended': 'TASK_RUN_WORKFLOW_UNATTENDED',
};

/** Narrows {@link resolveRunTarget}'s answer to the refusal arm. */
export function isRunTargetProblem(
  resolution: RunTargetResolution,
): resolution is RunTargetProblem {
  return resolution.kind === 'problem';
}

/**
 * One rung of the resolution: a request, a card, or a project.
 *
 * All three carry the same six fields, which is what lets them be read as a
 * list rather than as three hand-written `??` chains — the shape that let
 * `input.model ?? project.model` hand a cursor model to a claude run.
 */
export interface RunTargetLevel {
  agentKind?: AgentKind | null;
  model?: string | null;
  effort?: string | null;
  approval?: ChatApprovalMode | null;
  configDir?: string | null;
  workflowSlug?: string | null;
}

/**
 * What a card will actually be run as.
 *
 * The levels are read MOST SPECIFIC FIRST — this press, then the card, then the
 * project — and the first level naming a target decides which ARM the run takes
 * and nothing below it can change that. A level "names a target" by setting
 * either a workflow or an agent; one that sets neither is a level with nothing
 * to say, which is what makes the project's answer a default rather than a law.
 *
 * The trim fields (model, effort, approval, config directory) then fall back
 * INDEPENDENTLY through the same list, with one exclusion that is the whole
 * reason this is a function and not four `??` chains: a level naming a
 * DIFFERENT agent contributes nothing. A project pinned to cursor-agent with
 * `model: 'kimi-k3'` must not hand that model to a card the user pointed at
 * claude — which is exactly what per-field inheritance did before, silently,
 * because a model is an opaque string to everything between here and the CLI.
 *
 * A refusal is RETURNED and NAMES which refusal it is: both callers — the start
 * route and the autopilot queue — turn it into their own kind of message rather
 * than guessing an agent, and a card that names a workflow it may not run needs
 * a different sentence from one that names nothing at all.
 */
export function resolveRunTarget(
  levels: readonly RunTargetLevel[],
  startedBy: TaskRunStarter = 'user',
): RunTargetResolution {
  const deciding = levels.find(
    (level) =>
      nonEmpty(level.workflowSlug) !== null ||
      nonEmpty(level.agentKind) !== null,
  );
  if (deciding === undefined) {
    return { kind: 'problem', reason: 'no-target' };
  }

  const workflowSlug = nonEmpty(deciding.workflowSlug);
  if (workflowSlug !== null) {
    // The agent arm below can force ONE approval mode for an unattended run; a
    // workflow has no such field to force, since `approval` is per NODE in the
    // YAML and a node that asks is a legitimate thing to author. So the
    // combination is refused here rather than started and left to park.
    if (startedBy === 'autopilot') {
      return { kind: 'problem', reason: 'workflow-unattended' };
    }
    // The CLI-only fields are deliberately dropped rather than carried: a
    // workflow's nodes each name their own agent, model and approval in the
    // YAML, so there is nothing here for a run-level answer to apply to.
    return { kind: 'workflow', workflowSlug };
  }

  // Non-null by construction — `deciding` named one or the other, and the
  // workflow arm returned above.
  const agentKind = nonEmpty(deciding.agentKind) as AgentKind;
  const compatible = levels.filter((level) => {
    const named = nonEmpty(level.agentKind);
    return named === null || named === agentKind;
  });

  return {
    kind: 'agent',
    agentKind,
    model: firstOf(compatible, 'model'),
    effort: firstOf(compatible, 'effort'),
    // The one field a level cannot decide for an unattended run.
    approval:
      startedBy === 'autopilot'
        ? AUTOPILOT_APPROVAL
        : (firstOf(compatible, 'approval') as ChatApprovalMode | null),
    configDir: firstOf(compatible, 'configDir'),
  };
}

/**
 * The first level that actually sets `field`.
 *
 * A blank string counts as unset for the same reason null does: these arrive
 * from a client and from two database rows, and `model: ''` is the shape a
 * cleared form control takes — passing it on would send an empty `--model` to
 * a CLI rather than falling through to the project's answer.
 */
function firstOf(
  levels: readonly RunTargetLevel[],
  field: 'model' | 'effort' | 'approval' | 'configDir',
): string | null {
  for (const level of levels) {
    const value = nonEmpty(level[field]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

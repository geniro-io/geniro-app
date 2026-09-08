import type { ChatApprovalMode } from '../../agents/chat.types';
import type { AgentKind } from '../../runs/runs.types';
import type { ResolvedRunTarget, TaskRunStarter } from '../tasks.types';

/**
 * The approval mode an autopilot run is forced to.
 *
 * A mode that can ASK is refused rather than discouraged, and the reason is the
 * conductor's own (`apps/ui/src/main/autopilot-conductor.ts`): no approval
 * request expires — `approval-registry.ts` holds a plain Map with no timer —
 * and a turn's silence deadline is SUSPENDED while it waits on a verdict, so an
 * unattended turn does not time out, it waits forever, holding its slot against
 * the project's cap and its worktree on disk.
 *
 * **It was `acceptEdits`, which is exactly such a mode, and the board proved
 * it.** That value was chosen as the cautious one — auto-accept the file edits,
 * keep a human in front of everything else — and it does not survive contact
 * with a coding agent: `acceptEdits` maps to claude's own `--permission-mode`,
 * which auto-accepts EDITS and still routes every Bash call to the permission
 * prompt tool, i.e. to geniro's approval seam, i.e. to a card nobody is sitting
 * in front of. REPORTED with both of a board's unattended runs parked on
 * `Agent asks to run a tool · Bash` eleven minutes in — "он почему-то должен
 * быть опрувнутый же" — which is the deadlock this constant exists to prevent,
 * reached by the mode that was meant to prevent it. `auto` is the only value
 * that actually runs unattended: the DAEMON becomes the bypass, auto-approving
 * plain permission requests at its own seam while still reserving the human
 * card for a genuine question (see `ClaudeAdapter.buildArgs`).
 *
 * What that costs is real and worth stating: an autopilot run approves its own
 * commands. It is bounded by the machinery already around it — the run works in
 * its own git worktree on its own branch (`worktree-service.ts`), the cap
 * limits how many exist at once, and the breaker stops the board after three
 * consecutive failures — and it is opt-in per project, since arming the
 * autopilot is the user asking for work to happen while they are elsewhere.
 * A board that wants a human in the loop is a board that does not arm it.
 *
 * It is forced HERE rather than trusted to arrive in the request, which is
 * where it used to live alone. A project or a card may pin an approval mode of
 * its own, and the resolution below is most-specific-first — so a project set
 * to `ask` would outrank the conductor's value and hang every unattended run on
 * that board. The client still sends it; this is what makes the guarantee
 * independent of the client keeping its promise.
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
 * Returns null when no level names anything: that is the card the board cannot
 * start, and both callers — the start route and the autopilot queue — turn it
 * into their own kind of refusal rather than guessing an agent.
 */
export function resolveRunTarget(
  levels: readonly RunTargetLevel[],
  startedBy: TaskRunStarter = 'user',
): ResolvedRunTarget | null {
  const deciding = levels.find(
    (level) =>
      nonEmpty(level.workflowSlug) !== null ||
      nonEmpty(level.agentKind) !== null,
  );
  if (deciding === undefined) {
    return null;
  }

  const workflowSlug = nonEmpty(deciding.workflowSlug);
  if (workflowSlug !== null) {
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

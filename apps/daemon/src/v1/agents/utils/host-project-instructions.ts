import { formatPatch, OMIT_HEADERS, structuredPatch } from 'diff';

import { ProjectInstructionBlockSchema } from '../../projects/projects.types';
import {
  HOST_PROJECT_INSTRUCTIONS_TOOL,
  type HostProjectInstructions,
  type HostProjectInstructionsOutcome,
  RECOMMENDATION_ID_PREFIX,
  RecommendationIdSchema,
} from '../chat.types';
import { isHostToolCall } from './host-tool';

/** Context lines around each change, as `git diff` prints by default. */
const DIFF_CONTEXT = 3;

/**
 * Whether a permission request names `save_project_instructions`. Auto-approved
 * on `isHostPatchCall`'s reasoning: the call writes nothing, its card with the
 * old and new text is the gate.
 */
export function isHostProjectInstructionsCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_PROJECT_INSTRUCTIONS_TOOL);
}

/**
 * The changed lines of a project's instructions with three lines of context
 * around each, as unified-diff hunks; empty when nothing changed.
 */
export function instructionsDiff(
  previous: string | null,
  next: string | null,
): string {
  const asLines = (text: string | null): string =>
    text === null ? '' : `${text}\n`;
  const patch = structuredPatch(
    'instructions',
    'instructions',
    asLines(previous),
    asLines(next),
    undefined,
    undefined,
    { context: DIFF_CONTEXT },
  );
  return patch.hunks.length === 0
    ? ''
    : formatPatch(patch, OMIT_HEADERS).trimEnd();
}

/**
 * The card's `approval_request` input. `diff` is what the card draws; the
 * whole old and new text ride along in `Edit`'s field names so the card's
 * hidden-character scan reads every character either way.
 *
 * TWIN PARSER: apps/ui/src/renderer/chats/diff-view.tsx `editDiffOf` and
 * `projectInstructionsDiffOf` read `old_string` / `new_string` / `diff`, and
 * approval-card.tsx the `summary` heading.
 */
export function projectInstructionsCardInput(
  change: HostProjectInstructions,
): Record<string, unknown> {
  return {
    summary: `Change the instructions of project ${change.project}`,
    projectId: change.projectId,
    project: change.project,
    diff: instructionsDiff(change.previous, change.next),
    ...(change.previous === null ? {} : { old_string: change.previous }),
    new_string: change.next ?? '',
    ids: change.ids,
  };
}

/**
 * What the card's verdict row records of an Apply: whether it was saved, and
 * the revision it was saved as or why it was not.
 *
 * TWIN PARSER: apps/ui/src/renderer/chats/approval-card.tsx `PermissionCard`
 * reads `outcome` and `answer` off the `approval_verdict` row.
 */
export function projectInstructionsVerdict(
  outcome: HostProjectInstructionsOutcome,
): { outcome?: 'saved' | 'not-saved'; answer?: string } {
  switch (outcome.status) {
    case 'saved':
      return {
        outcome: 'saved',
        answer: `saved as revision ${outcome.instructionsRevision}`,
      };
    case 'stale':
      return { outcome: 'not-saved', answer: outcome.reason };
    default:
      return {};
  }
}

/** What identifies a deferred card, so an identical re-ask adopts it. */
export function projectInstructionsCardKey(
  change: HostProjectInstructions,
): string {
  return `project:${JSON.stringify({
    projectId: change.projectId,
    blocks: change.blocks,
    baseRevision: change.baseRevision,
    ids: change.ids,
  })}`;
}

/** A stored card read back, or null for anything that does not read as one. */
export function readHostProjectInstructions(
  raw: unknown,
): HostProjectInstructions | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const text = (value: unknown): value is string | null =>
    value === null || typeof value === 'string';
  const count = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0;
  const blocks = ProjectInstructionBlockSchema.array().safeParse(record.blocks);
  if (
    !blocks.success ||
    typeof record.projectId !== 'string' ||
    record.projectId.length === 0 ||
    typeof record.project !== 'string' ||
    !text(record.previous) ||
    !text(record.next) ||
    !count(record.baseRevision) ||
    !(record.cardSeq === null || count(record.cardSeq)) ||
    !Array.isArray(record.ids) ||
    (record.ids.length === 0) !== (record.cardSeq === null) ||
    !record.ids.every(
      (id): id is string =>
        RecommendationIdSchema.safeParse(id).success &&
        (id as string).startsWith(RECOMMENDATION_ID_PREFIX.project),
    )
  ) {
    return null;
  }
  return {
    projectId: record.projectId,
    project: record.project,
    previous: record.previous,
    next: record.next,
    blocks: blocks.data,
    baseRevision: record.baseRevision,
    ids: record.ids,
    cardSeq: record.cardSeq,
  };
}

/** What the agent is told once the card is answered; `fromChat` for the project chat's own change. */
export function hostProjectInstructionsResultText(
  outcome: HostProjectInstructionsOutcome,
  fromChat = false,
): string {
  if (fromChat) {
    switch (outcome.status) {
      case 'stale':
        return `The user accepted the change but it could not be saved (${outcome.reason}). Nothing was written; tell the user, and propose it again on their word.`;
      case 'posted':
        return `The change is now on the user’s screen, waiting for them. STOP HERE and end your turn, and do not call this tool again for the same change. Their ${outcome.buttons ?? 'Apply or Reject'} arrives as your next user message.`;
      default:
        break;
    }
  }
  switch (outcome.status) {
    case 'saved':
      return `The user applied the change; the project's instructions are saved as revision ${outcome.instructionsRevision}. Do not write them again.`;
    case 'declined':
      return 'The user rejected the change to the project’s instructions. Nothing was written; do not write it another way — ask what they would prefer.';
    case 'stale':
      return `The user accepted the change but it could not be saved (${outcome.reason}). Read view="project" again and propose against the current text.`;
    case 'posted':
      return 'The change is now on the user’s screen, waiting for them. STOP HERE and end your turn, and do not call this tool again for the same change. When they answer, what happened arrives as your next user message: mark this project’s items then, and only then save the next project.';
    case 'unavailable':
      return `The change could not be put to the user (${outcome.reason}). Describe it in your reply instead.`;
  }
}

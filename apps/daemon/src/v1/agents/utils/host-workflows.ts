import {
  HOST_PROPOSE_WORKFLOW_TOOL,
  HOST_READ_WORKFLOWS_TOOL,
  MAX_ANSWER_LENGTH,
  PendingOwnedCardSchema,
  type WorkflowProposalVerdict,
} from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names geniro's own `propose_workflow`.
 *
 * Auto-approved because proposing writes nothing: it puts a card on screen,
 * and the file is written only behind that card's Approve — a permission card
 * in front of it would ask the user to approve being asked.
 */
export function isHostWorkflowProposalCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_PROPOSE_WORKFLOW_TOOL);
}

/**
 * The card id `Run.pendingWorkflowProposal` names, or null — read WITHOUT the
 * proposal, so the one id both readers of the column act on is the same: the
 * boot reconcile spares this card, and `WorkflowProposalService.rehydrate`
 * closes it when its proposal no longer parses rather than leaving it live.
 */
export function standingProposalCardId(column: string | null): string | null {
  if (column === null) {
    return null;
  }
  try {
    const parsed = PendingOwnedCardSchema.safeParse(JSON.parse(column));
    return parsed.success ? parsed.data.requestId : null;
  } catch {
    return null;
  }
}

/**
 * The run's next message once the user answered a `propose_workflow` card.
 *
 * In parentheses, as `deferredAnswerMessage`'s geniro arms are, so the model
 * never quotes geniro's words back as the user's; the note IS the user's
 * and is quoted as theirs.
 */
export function workflowVerdictMessage(
  verdict: WorkflowProposalVerdict,
): string {
  const note = (verdict.note ?? '').trim().slice(0, MAX_ANSWER_LENGTH);
  const noted = note.length === 0 ? '' : ` The user's note: ${note}`;
  switch (verdict.kind) {
    case 'saved':
      return `(Approved — saved as '${verdict.slug}' in the workflow library.${
        verdict.backup === null
          ? ''
          : ` The previous version is backed up as ${verdict.backup}.`
      }${noted})`;
    case 'declined':
      return note.length === 0
        ? '(Declined — the user gave no reason. Nothing was saved.)'
        : `(Declined — nothing was saved.${noted})`;
    case 'not-saved':
      return `(Not saved — ${verdict.reason}. Read the library again with ${HOST_READ_WORKFLOWS_TOOL} before proposing again.${noted})`;
  }
}

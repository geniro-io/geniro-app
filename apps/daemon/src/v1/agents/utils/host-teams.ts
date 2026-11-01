import {
  HOST_BACKUP_TEAM_TOOL,
  HOST_PROPOSE_TEAM_TOOL,
  HOST_READ_TEAMS_TOOL,
  HOST_TEAM_CHANGE_TOOL,
  MAX_ANSWER_LENGTH,
  PendingOwnedCardSchema,
  type TeamProposalVerdict,
} from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names geniro's own `propose_team`.
 *
 * Auto-approved because proposing writes nothing: it puts a card on screen,
 * and the file is written only behind that card's Approve — a permission card
 * in front of it would ask the user to approve being asked.
 */
export function isHostTeamProposalCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_PROPOSE_TEAM_TOOL);
}

/**
 * Whether a team builder chat's call to its own team tools goes
 * without a card — asked only on a builder turn.
 *
 * Its read is a library read the user opened this chat to have done, its
 * backup only copies the file aside, and its `save_team_change` is a check
 * that writes nothing: the change itself is written behind
 * `propose_team`'s card ({@link isHostTeamProposalCall}).
 */
export function isHostBuilderTeamCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return (
    isHostToolCall(serverName, toolName, HOST_READ_TEAMS_TOOL) ||
    isHostToolCall(serverName, toolName, HOST_BACKUP_TEAM_TOOL) ||
    isHostToolCall(serverName, toolName, HOST_TEAM_CHANGE_TOOL)
  );
}

/**
 * The card id `Run.pendingTeamProposal` names, or null — read WITHOUT the
 * proposal, so the one id both readers of the column act on is the same: the
 * boot reconcile spares this card, and `TeamProposalService.rehydrate`
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
 * The run's next message once the user answered a `propose_team` card.
 *
 * In parentheses, as `deferredAnswerMessage`'s geniro arms are, so the model
 * never quotes geniro's words back as the user's; the note IS the user's
 * and is quoted as theirs.
 */
export function teamVerdictMessage(verdict: TeamProposalVerdict): string {
  const note = (verdict.note ?? '').trim().slice(0, MAX_ANSWER_LENGTH);
  const noted = note.length === 0 ? '' : ` The user's note: ${note}`;
  switch (verdict.kind) {
    case 'saved':
      return `(Approved — saved as '${verdict.slug}' in the team library.${
        verdict.backup === null
          ? ''
          : ` The previous version is backed up as ${verdict.backup}.`
      }${noted})`;
    case 'declined':
      return note.length === 0
        ? '(Declined — the user gave no reason. Nothing was saved.)'
        : `(Declined — nothing was saved.${noted})`;
    case 'not-saved':
      return `(Not saved — ${verdict.reason}. Read the library again with ${HOST_READ_TEAMS_TOOL} before proposing again.${noted})`;
  }
}

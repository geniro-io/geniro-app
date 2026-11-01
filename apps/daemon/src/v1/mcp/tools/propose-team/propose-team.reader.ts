import { z } from 'zod';

import { hasHiddenText } from '../../../agents/utils/hidden-text';
import {
  type ProposalOutcome,
  TEAM_REASON_MAX,
  TEAM_SUMMARY_MAX,
  type TeamChangeProposalRequest,
  type TeamProposalRequest,
} from '../../../teams/teams.types';
import type { ToolArgs } from '../../mcp.types';
import { editsField } from '../team-edit-args';
import { readToolArgs } from '../tool-args';

// One line, capped: the card prints this ahead of the slug and the team,
// so an unbounded one could push them out of sight.
const summaryField = z
  .string()
  .max(TEAM_SUMMARY_MAX)
  .refine(
    (summary) => !hasHiddenText(summary, false),
    'summary must be one line of visible text',
  );

// Capped for the same reason; line breaks are kept, the card draws them.
const reasonField = z
  .string()
  .max(TEAM_REASON_MAX)
  .refine(
    (reason) => !hasHiddenText(reason, true),
    'reason must be visible text',
  );

/**
 * Strict on the names, so a misspelt `replace` cannot quietly turn a
 * replacement into a second team. The team itself is read whole and
 * checked by the service against the library's own schema.
 */
const ProposeTeamArgsSchema = z
  .object({
    team: z.record(z.string(), z.unknown()),
    replaces: z.string().min(1).optional(),
    summary: summaryField.optional(),
    reason: reasonField.optional(),
  })
  .strict();

/**
 * A team builder chat's proposal: edits to its own team, never the
 * whole of it, and no target — the slug is the chat's. `team` and
 * `replaces` are refused as unknown. What it changes and why are required:
 * they are the card's account of a change the user did not draw themselves.
 */
export const ProposeTeamChangeArgsSchema = z
  .object({
    edits: editsField('the team file as it stands'),
    summary: summaryField,
    reason: reasonField,
  })
  .strict();

/** The call's arguments, or what is wrong with them. Never throws. */
export function readProposeTeamArgs(
  args: Record<string, unknown>,
): ToolArgs<TeamProposalRequest> {
  return readToolArgs(ProposeTeamArgsSchema, args);
}

/** A builder chat's call arguments, or what is wrong with them. Never throws. */
export function readProposeTeamChangeArgs(
  args: Record<string, unknown>,
): ToolArgs<Omit<TeamChangeProposalRequest, 'slug'>> {
  return readToolArgs(ProposeTeamChangeArgsSchema, args);
}

/** What the agent is told once the call is answered. */
export function proposeTeamResultText(outcome: ProposalOutcome): string {
  if (outcome.status === 'refused') {
    return `Not proposed — ${outcome.code}: ${outcome.message}. No card was shown.`;
  }
  const { proposal } = outcome;
  const what =
    proposal.mode === 'create'
      ? `a new team, to be saved as '${proposal.slug}'`
      : `a replacement of '${proposal.slug}' (${proposal.replacesName})`;
  return `Shown to the user on a card: ${what}. Nothing is saved until they approve. End your turn now — their verdict arrives as your next message.`;
}

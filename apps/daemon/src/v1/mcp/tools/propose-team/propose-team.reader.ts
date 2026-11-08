import { z } from 'zod';

import { hasHiddenText } from '../../../agents/utils/hidden-text';
import {
  type ProposalOutcome,
  TEAM_REASON_MAX,
  TEAM_SUMMARY_MAX,
  type TeamChangeProposalRequest,
} from '../../../teams/teams.types';
import type { ToolArgs } from '../../mcp.types';
import { blocksField } from '../project-block-args';
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
const WholeTeamArgsSchema = z
  .object({
    team: z.record(z.string(), z.unknown()),
    replaces: z.string().min(1).optional(),
    summary: summaryField.optional(),
    reason: reasonField.optional(),
  })
  .strict();

export const TEAM_EDITS_READ_COPY =
  'the team as read_teams answers it — copy a `find` from the text between a field’s `===` markers';

const TeamEditsArgsSchema = z
  .object({
    replaces: z.string().min(1),
    edits: editsField(TEAM_EDITS_READ_COPY),
    summary: summaryField,
    reason: reasonField,
  })
  .strict();

/**
 * An ordinary chat's change to one project's overlay: the project is named,
 * and the team is the one that project runs by default, never the model's.
 */
export const ChatOverlayArgsSchema = z
  .object({
    overlay: z
      .record(z.string(), z.unknown())
      .describe("The project's WHOLE overlay document as it should stand"),
    overlayProjectId: z
      .string()
      .min(1)
      .max(200)
      .describe("The project's `id` list_projects names"),
    summary: summaryField,
    reason: reasonField,
  })
  .strict();

export type ChatTeamProposal =
  | z.infer<typeof WholeTeamArgsSchema>
  | z.infer<typeof TeamEditsArgsSchema>
  | z.infer<typeof ChatOverlayArgsSchema>;

/**
 * A team builder chat's proposal: edits to its own team, never the
 * whole of it, and no target — the slug is the chat's. `team` and
 * `replaces` are refused as unknown. What it changes and why are required:
 * they are the card's account of a change the user did not draw themselves.
 */
export const ProposeTeamChangeArgsSchema = z
  .object({
    edits: editsField('the team file as it stands').optional(),
    overlay: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "The bound project's WHOLE overlay document — only in a chat bound to a project",
      ),
    project: z
      .object({
        projectId: z
          .string()
          .min(1)
          .max(200)
          .describe(
            'A project that runs this team by default — read_teams with `projects` names each',
          ),
        blocks: blocksField('read_teams with `projects`'),
        baseRevision: z
          .number()
          .int()
          .min(0)
          .describe('The `instructionsRevision` read_teams named for it'),
      })
      .strict()
      .optional()
      .describe(
        "A change to that project's own instruction blocks, written by the same approval as the edits — how text moves between the team and the project in one change",
      ),
    summary: summaryField,
    reason: reasonField,
  })
  .strict()
  .refine(
    (args) =>
      args.edits !== undefined ||
      args.overlay !== undefined ||
      args.project !== undefined,
    { message: 'send `edits`, `overlay`, `project`, or several' },
  );

/**
 * A project chat's proposal: the project's whole overlay of its default team,
 * never the team itself, which is changed on its own page.
 */
export const ProposeProjectOverlayArgsSchema = z
  .object({
    overlay: z
      .record(z.string(), z.unknown())
      .describe("The project's WHOLE overlay document as it should stand"),
    summary: summaryField,
    reason: reasonField,
  })
  .strict();

/** A project chat's call arguments, or what is wrong with them. Never throws. */
export function readProposeProjectOverlayArgs(
  args: Record<string, unknown>,
): ToolArgs<z.infer<typeof ProposeProjectOverlayArgsSchema>> {
  return readToolArgs(ProposeProjectOverlayArgsSchema, args);
}

/** The call's arguments, or what is wrong with them. Never throws. */
export function readProposeTeamArgs(
  args: Record<string, unknown>,
): ToolArgs<ChatTeamProposal> {
  const given = Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== null),
  );
  if ('edits' in given && 'team' in given) {
    return {
      ok: false,
      error:
        'send `team` for a new team, or `edits` with `replaces` for a change to one — never both',
    };
  }
  if ('overlay' in given) {
    return 'team' in given || 'edits' in given || 'replaces' in given
      ? {
          ok: false,
          error:
            'send `overlay` with `overlayProjectId` alone — a change to a team goes on its own card',
        }
      : readToolArgs(ChatOverlayArgsSchema, args);
  }
  return 'edits' in given
    ? readToolArgs(TeamEditsArgsSchema, args)
    : readToolArgs(WholeTeamArgsSchema, args);
}

/** A builder chat's call arguments, or what is wrong with them. Never throws. */
export function readProposeTeamChangeArgs(
  args: Record<string, unknown>,
): ToolArgs<Omit<TeamChangeProposalRequest, 'slug' | 'projectId'>> {
  const read = readToolArgs(ProposeTeamChangeArgsSchema, args);
  return read.ok
    ? { ok: true, query: { ...read.query, edits: read.query.edits ?? [] } }
    : read;
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

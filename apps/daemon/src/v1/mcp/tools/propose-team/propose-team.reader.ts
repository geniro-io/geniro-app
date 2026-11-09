import { z } from 'zod';

import { hasHiddenText } from '../../../agents/utils/hidden-text';
import {
  type ProposalOutcome,
  TEAM_REASON_MAX,
  TEAM_SUMMARY_MAX,
  type TeamProposal,
} from '../../../teams/teams.types';
import type { TeamEdit } from '../../../teams/utils/team-edits';
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

export const TEAM_EDITS_READ_COPY =
  'the team as read_teams answers it — copy a `find` from the text between a field’s `===` markers';

/** A change to the instructions of a project that runs the team, on the team's card. */
export const ProjectHalfSchema = z
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
  .strict();

/**
 * One form in every chat. Strict on the names, so a misspelt `replace` cannot
 * quietly turn a replacement into a second team. The team itself is read whole
 * and checked by the service against the library's own schema.
 */
const ProposeTeamArgsSchema = z
  .object({
    team: z.record(z.string(), z.unknown()).optional(),
    replaces: z.string().min(1).optional(),
    edits: editsField(TEAM_EDITS_READ_COPY).optional(),
    overlay: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("The project's WHOLE overlay document as it should stand"),
    overlayProjectId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("The project's `id` list_projects names"),
    project: ProjectHalfSchema.optional(),
    summary: summaryField.optional(),
    reason: reasonField.optional(),
  })
  .strict();

/** A whole team: a new one, or a replacement of the slug named. */
export interface WholeTeamProposal {
  team: Record<string, unknown>;
  replaces?: string;
  summary?: string;
  reason?: string;
}

/** A change to what the library or a project holds, with the card's account of it. */
export interface TeamChangeProposal {
  replaces?: string;
  edits: TeamEdit[];
  overlay?: Record<string, unknown>;
  overlayProjectId?: string;
  project?: z.infer<typeof ProjectHalfSchema>;
  summary: string;
  reason: string;
}

export type ChatTeamProposal = WholeTeamProposal | TeamChangeProposal;

/** The call's arguments, or what is wrong with them. Never throws. */
export function readProposeTeamArgs(
  args: Record<string, unknown>,
): ToolArgs<ChatTeamProposal> {
  const read = readToolArgs(ProposeTeamArgsSchema, args);
  if (!read.ok) {
    return read;
  }
  const { team, replaces, edits, overlay, overlayProjectId, project } =
    read.query;
  const { summary, reason } = read.query;
  if (team !== undefined) {
    if (
      edits !== undefined ||
      overlay !== undefined ||
      overlayProjectId !== undefined ||
      project !== undefined
    ) {
      return {
        ok: false,
        error:
          'send `team` for a new team, or `edits`, `overlay` or `project` for a change — never both',
      };
    }
    return {
      ok: true,
      query: {
        team,
        ...(replaces === undefined ? {} : { replaces }),
        ...(summary === undefined ? {} : { summary }),
        ...(reason === undefined ? {} : { reason }),
      },
    };
  }
  if (edits === undefined && overlay === undefined && project === undefined) {
    return {
      ok: false,
      error:
        "send `team` for a new team, `edits` for a change to one, `overlay` for a project's overlay, or `project` beside `replaces`",
    };
  }
  if (overlayProjectId !== undefined && overlay === undefined) {
    return {
      ok: false,
      error: '`overlayProjectId` names whose `overlay` it is — send both',
    };
  }
  if (summary === undefined || reason === undefined) {
    return {
      ok: false,
      error:
        'a change carries a one-line `summary` of what it does and a `reason` why: the card shows both',
    };
  }
  return {
    ok: true,
    query: {
      edits: edits ?? [],
      summary,
      reason,
      ...(replaces === undefined ? {} : { replaces }),
      ...(overlay === undefined ? {} : { overlay }),
      ...(overlayProjectId === undefined ? {} : { overlayProjectId }),
      ...(project === undefined ? {} : { project }),
    },
  };
}

/** What one change is written to: a team and what goes beside it, or an overlay alone. */
export type ProposalTarget =
  | { kind: 'team'; slug: string; projectId: string | null }
  | { kind: 'overlay'; projectId: string; overlay: Record<string, unknown> };

/**
 * Where a change lands, or what it must name: what it leaves unnamed is the
 * chat's own team or project, where it has one. An overlay naming its project,
 * with nothing else changing, is that project's default team's whatever team
 * this chat edits.
 */
export function proposalTargetOf(
  change: TeamChangeProposal,
  own: { team: string | null; project: string | null },
): ProposalTarget | string {
  const projectId =
    change.overlay === undefined
      ? null
      : (change.overlayProjectId ?? own.project);
  if (change.overlay !== undefined && projectId === null) {
    return 'name the project this overlay belongs to in `overlayProjectId` — list_projects names them';
  }
  const changesTeam = change.edits.length > 0 || change.project !== undefined;
  const slug =
    change.replaces ??
    (changesTeam || change.overlayProjectId === undefined ? own.team : null);
  if (slug !== null) {
    return { kind: 'team', slug, projectId };
  }
  if (changesTeam || change.overlay === undefined || projectId === null) {
    return 'name the team this changes in `replaces` — read_teams lists them';
  }
  return { kind: 'overlay', projectId, overlay: change.overlay };
}

/** What the agent is told once the call is answered. */
export function proposeTeamResultText(outcome: ProposalOutcome): string {
  if (outcome.status === 'refused') {
    return `Not proposed — ${outcome.code}: ${outcome.message}. No card was shown.`;
  }
  return `Shown to the user on a card: ${whatTheCardWrites(outcome.proposal)}. Nothing is saved until they approve. End your turn now — their verdict arrives as your next message.`;
}

/** What one approval of the card writes, in the card's own order. */
function whatTheCardWrites(proposal: TeamProposal): string {
  if (proposal.mode === 'create') {
    return `a new team, to be saved as '${proposal.slug}'`;
  }
  return [
    proposal.diff.identical
      ? null
      : `a replacement of '${proposal.slug}' (${proposal.replacesName})`,
    proposal.overlay === undefined
      ? null
      : `the overlay of ${proposal.overlay.projectName}`,
    proposal.project === undefined
      ? null
      : `the instructions of ${proposal.project.projectName}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' and ');
}

import { z } from 'zod';

import { HOST_READ_TEAMS_TOOL } from '../../../agents/chat.types';
import {
  TEAM_REASON_MAX,
  TEAM_SUMMARY_MAX,
  TeamOverlaySchema,
  TeamSchema,
} from '../../../teams/teams.types';
import { CONFIG_DIR_TOKEN_PREFIX } from '../../../teams/utils/config-dir-redaction';
import { editsField } from '../team-edit-args';
import { toolInputSchema } from '../tool-args';
import { ProjectHalfSchema, TEAM_EDITS_READ_COPY } from './propose-team.reader';

/** Which chat is listing the tool: it decides only what a call naming no target means. */
export type ProposeTeamAudience = 'chat' | 'builder' | 'project' | 'analysis';

const REASON_DESCRIPTION = `Why, for the card, at most ${TEAM_REASON_MAX} characters: what the user asked for or what you found that this answers. Required with \`edits\`, \`overlay\` or \`project\`.`;

/** The JSON Schema of one zod schema, without its dialect line. */
function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, {
    io: 'input',
  });
  return json;
}

/**
 * `propose_team`'s arguments, the same in every chat. `team` and `overlay` are
 * GENERATED from the schemas a proposal is checked against, so the shape a model
 * is shown cannot drift from the one it is held to.
 */
export function proposeTeamSchema(
  audience: ProposeTeamAudience,
): Record<string, unknown> {
  const changes = toolInputSchema(
    z.object({
      edits: editsField(TEAM_EDITS_READ_COPY),
      project: ProjectHalfSchema,
    }),
  ).properties as Record<string, unknown>;
  return {
    type: 'object',
    properties: {
      team: {
        ...jsonSchemaOf(TeamSchema),
        description: `A NEW team, whole, as the library file would hold it. Every member states its own \`approval\`. To change a team the library holds, send \`edits\` with \`replaces\` instead — never the whole team. A \`configDir\` read from ${HOST_READ_TEAMS_TOOL} as "${CONFIG_DIR_TOKEN_PREFIX}…>" is sent back as that token; never guess a path.`,
      },
      edits: changes.edits,
      replaces: {
        type: 'string',
        description:
          audience === 'builder'
            ? `With \`edits\`: the slug of another library team they change, as ${HOST_READ_TEAMS_TOOL} names it. Leave it out for the team this chat edits.`
            : `With \`edits\`: the slug of the library team they change, as ${HOST_READ_TEAMS_TOOL} names it. Leave it out for a new team.`,
      },
      overlay: {
        ...jsonSchemaOf(TeamOverlaySchema),
        description: `A project's WHOLE overlay of its default team as it should stand, the one ${HOST_READ_TEAMS_TOOL} answers with your change made; an empty object removes every override. Alone it leaves the team as it is; beside \`edits\` the same approval writes both, and the project must default to that team.`,
      },
      overlayProjectId: {
        type: 'string',
        description:
          audience === 'project'
            ? "With `overlay`: the `id` list_projects names of another project. Leave it out for this chat's own."
            : "With `overlay`: the project's `id` list_projects names.",
      },
      project: {
        ...(changes.project as Record<string, unknown>),
        description: `A change to the instruction blocks of a project that runs this team by default, written by the same approval as the edits — how text moves between a team and a project in one change. Goes with \`edits\` or \`replaces\`.`,
      },
      recommendation_ids: {
        type: 'array',
        items: { type: 'string' },
        description: `After an Apply: the W-, O- and P- ids from the card that this change carries out, each selected there. The logs keep them, so a later analysis can tell what each item changed. Leave it out for a change the user asked for in words.`,
      },
      summary: {
        type: 'string',
        description: `One line for the card, at most ${TEAM_SUMMARY_MAX} characters: what this team does, or what the change does. Required with \`edits\`, \`overlay\` or \`project\`.`,
      },
      reason: {
        type: 'string',
        description: REASON_DESCRIPTION,
      },
    },
    additionalProperties: false,
  };
}

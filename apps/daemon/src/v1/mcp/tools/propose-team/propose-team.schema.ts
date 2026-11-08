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
import {
  ProposeProjectOverlayArgsSchema,
  ProposeTeamChangeArgsSchema,
  TEAM_EDITS_READ_COPY,
} from './propose-team.reader';

/** Which chat is listing the tool: an ordinary one, a team's builder, or a project's own. */
export type ProposeTeamAudience = 'chat' | 'builder' | 'project';

const REASON_DESCRIPTION = `Why, for the card, at most ${TEAM_REASON_MAX} characters: what the user asked for or what you found that this answers.`;

/**
 * `propose_team`'s arguments. `team` is GENERATED from `TeamSchema`,
 * the schema the proposal is checked against, so the shape a model is shown
 * cannot drift from the one it is held to. A builder chat's are generated from
 * the schema they are parsed with: edits, what they change and why.
 */
function overlayJsonSchema(): Record<string, unknown> {
  const { $schema: _dialect, ...overlay } = z.toJSONSchema(TeamOverlaySchema, {
    io: 'input',
  });
  return overlay;
}

export function proposeTeamSchema(
  audience: ProposeTeamAudience,
): Record<string, unknown> {
  if (audience === 'project') {
    const schema = toolInputSchema(ProposeProjectOverlayArgsSchema);
    const properties = schema.properties as Record<string, unknown>;
    return {
      ...schema,
      properties: {
        ...properties,
        overlay: {
          ...overlayJsonSchema(),
          description:
            "This project's WHOLE overlay document as it should stand, the one your brief shows with your change made; an empty object removes every override.",
        },
        summary: {
          ...(properties.summary as Record<string, unknown>),
          description: `One line for the card, at most ${TEAM_SUMMARY_MAX} characters: what this change does to how the team works in this project.`,
        },
        reason: {
          ...(properties.reason as Record<string, unknown>),
          description: REASON_DESCRIPTION,
        },
      },
    };
  }
  if (audience === 'builder') {
    const schema = toolInputSchema(ProposeTeamChangeArgsSchema);
    const properties = schema.properties as Record<string, unknown>;
    return {
      ...schema,
      properties: {
        ...properties,
        summary: {
          ...(properties.summary as Record<string, unknown>),
          description: `One line for the card, at most ${TEAM_SUMMARY_MAX} characters: what this change does to the team.`,
        },
        reason: {
          ...(properties.reason as Record<string, unknown>),
          description: REASON_DESCRIPTION,
        },
        overlay: {
          ...overlayJsonSchema(),
          description:
            "Only in a chat bound to a project: that project's WHOLE overlay document as it should stand (read the file first; a missing file is an empty overlay). Shown beside the team edits on the same card and written by the same approval.",
        },
      },
    };
  }
  const { $schema: _dialect, ...team } = z.toJSONSchema(TeamSchema, {
    io: 'input',
  });
  const editsSchema = toolInputSchema(
    z.object({ edits: editsField(TEAM_EDITS_READ_COPY) }),
  );
  return {
    type: 'object',
    properties: {
      team: {
        ...team,
        description: `A NEW team, whole, as the library file would hold it. Every member states its own \`approval\`. To change a team the library holds, send \`edits\` with \`replaces\` instead — never the whole team. A \`configDir\` read from ${HOST_READ_TEAMS_TOOL} as "${CONFIG_DIR_TOKEN_PREFIX}…>" is sent back as that token; never guess a path.`,
      },
      edits: (editsSchema.properties as Record<string, unknown>).edits,
      replaces: {
        type: 'string',
        description: `With \`edits\`: the slug of the library team they change, as ${HOST_READ_TEAMS_TOOL} names it. Leave it out for a new team.`,
      },
      overlay: {
        ...overlayJsonSchema(),
        description: `With \`overlayProjectId\`, and without \`team\`, \`edits\` or \`replaces\`: that project's WHOLE overlay of its default team as it should stand, the one ${HOST_READ_TEAMS_TOOL} answers with your change made; an empty object removes every override.`,
      },
      overlayProjectId: {
        type: 'string',
        description: "With `overlay`: the project's `id` list_projects names.",
      },
      summary: {
        type: 'string',
        description: `One line for the card, at most ${TEAM_SUMMARY_MAX} characters: what this team does, or what the change does. Required with \`edits\` or \`overlay\`.`,
      },
      reason: {
        type: 'string',
        description: `${REASON_DESCRIPTION} Required with \`edits\` or \`overlay\`.`,
      },
    },
    additionalProperties: false,
  };
}

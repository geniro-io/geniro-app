import { z } from 'zod';

import { HOST_READ_TEAMS_TOOL } from '../../../agents/chat.types';
import {
  TEAM_REASON_MAX,
  TEAM_SUMMARY_MAX,
  TeamSchema,
} from '../../../teams/teams.types';
import { CONFIG_DIR_TOKEN_PREFIX } from '../../../teams/utils/config-dir-redaction';
import { toolInputSchema } from '../tool-args';
import { ProposeTeamChangeArgsSchema } from './propose-team.reader';

const REASON_DESCRIPTION = `Why, for the card, at most ${TEAM_REASON_MAX} characters: what the user asked for or what you found that this answers.`;

/**
 * `propose_team`'s arguments. `team` is GENERATED from `TeamSchema`,
 * the schema the proposal is checked against, so the shape a model is shown
 * cannot drift from the one it is held to. A builder chat's are generated from
 * the schema they are parsed with: edits, what they change and why.
 */
export function proposeTeamSchema(
  forBuilder: boolean,
): Record<string, unknown> {
  if (forBuilder) {
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
      },
    };
  }
  const { $schema: _dialect, ...team } = z.toJSONSchema(TeamSchema, {
    io: 'input',
  });
  return {
    type: 'object',
    properties: {
      team: {
        ...team,
        description: `The whole team, as the library file would hold it. Every member states its own \`approval\`. A \`configDir\` read from ${HOST_READ_TEAMS_TOOL} as "${CONFIG_DIR_TOKEN_PREFIX}…>" is sent back as that token (only when replacing that team); never guess a path.`,
      },
      replaces: {
        type: 'string',
        description: `The slug of the library team this proposal replaces, as ${HOST_READ_TEAMS_TOOL} names it. Leave it out for a new team.`,
      },
      summary: {
        type: 'string',
        description: `One line for the card, at most ${TEAM_SUMMARY_MAX} characters: what this team does, or what the replacement changes.`,
      },
      reason: { type: 'string', description: REASON_DESCRIPTION },
    },
    required: ['team'],
    additionalProperties: false,
  };
}

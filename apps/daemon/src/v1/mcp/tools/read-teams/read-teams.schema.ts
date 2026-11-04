import type { ReadTeamsAudience } from './read-teams.instructions';

/** `read_teams`'s arguments: none in a project's chat, which reads its own team. */
export function readTeamsSchema(
  audience: ReadTeamsAudience,
): Record<string, unknown> {
  if (audience === 'project') {
    return { type: 'object', properties: {}, additionalProperties: false };
  }
  return {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description:
          'One team to read in full, by the slug the listing names. Leave it out to list the library.',
      },
    },
    additionalProperties: false,
  };
}

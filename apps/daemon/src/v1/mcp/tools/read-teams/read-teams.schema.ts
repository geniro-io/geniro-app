/** `read_teams`'s arguments. */
export function readTeamsSchema(): Record<string, unknown> {
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

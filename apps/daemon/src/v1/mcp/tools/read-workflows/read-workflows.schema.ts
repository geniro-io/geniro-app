/** `read_workflows`'s arguments. */
export function readWorkflowsSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description:
          'One workflow to read in full, by the slug the listing names. Leave it out to list the library.',
      },
    },
    additionalProperties: false,
  };
}

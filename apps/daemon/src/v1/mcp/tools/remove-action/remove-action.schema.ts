/** `remove_action`'s arguments. */
export function removeActionSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      action_id: {
        type: 'string',
        description: 'The id publish_action reported for the button.',
      },
    },
    required: ['action_id'],
  };
}

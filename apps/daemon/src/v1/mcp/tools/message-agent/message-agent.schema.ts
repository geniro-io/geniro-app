/** `message_agent`'s arguments. */
export function messageAgentSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      call_id: {
        type: 'string',
        description: 'The call_id of YOUR running call.',
      },
      message: {
        type: 'string',
        description:
          'What to tell the callee — self-contained, quoting the user verbatim where it is their correction.',
      },
    },
    required: ['call_id', 'message'],
  };
}

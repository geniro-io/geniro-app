/** `answer_agent`'s arguments. */
export function answerAgentSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      call_id: {
        type: 'string',
        description: 'The call_id from the {"status":"question"} envelope.',
      },
      answer: {
        type: 'string',
        description:
          "Your answer — an offered option's label when one fits, or free text.",
      },
    },
    required: ['call_id', 'answer'],
  };
}

import { MAX_CANCEL_REASON_LENGTH } from './cancel-agent.reader';

/** `cancel_agent`'s arguments. */
export function cancelAgentSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      call_id: {
        type: 'string',
        description: 'The call_id of YOUR call to stop.',
      },
      reason: {
        type: 'string',
        description: `Why this call is no longer worth finishing, in one sentence — recorded on the run and shown to the user. At most ${MAX_CANCEL_REASON_LENGTH} characters.`,
      },
    },
    required: ['call_id', 'reason'],
  };
}

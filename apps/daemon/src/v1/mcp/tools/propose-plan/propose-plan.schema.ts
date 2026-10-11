import { MAX_PLAN_STEPS } from '../../../agents/chat.types';

/** `propose_plan`'s arguments. */
export function proposePlanSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          'What the plan is FOR, as the card\'s heading — e.g. "Make the queue test deterministic". Say the ' +
          'goal, not "Plan".',
      },
      steps: {
        type: 'array',
        description: `The steps in the order you would do them — at most ${MAX_PLAN_STEPS}, and fewer is better. Each is one thing you will do, not a category of work.`,
        items: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description:
                'The step in one line, starting with a verb — e.g. "Replace the sleep with a wait-for".',
            },
            detail: {
              type: 'string',
              description:
                'A sentence or two where the step needs it — the file it touches, the risk, the thing you ' +
                'are unsure about. Optional, and better omitted than padded.',
            },
          },
          required: ['title'],
        },
      },
    },
    required: ['title', 'steps'],
  };
}

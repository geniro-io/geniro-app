import { STAGE_MOVE_ACTIONS } from '../../../agents/chat.types';

export function moveStageSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...STAGE_MOVE_ACTIONS],
        description:
          'complete = the stage is finished; skip = it does not apply to this run; reopen = a finished or skipped stage needs more work.',
      },
      stage: {
        type: 'string',
        description:
          'The id of the stage to move — the current one for complete and skip.',
      },
      next: {
        type: 'string',
        description:
          'At a stage followed by ONE of several stages: the id of the one the run takes. Leave it out elsewhere.',
      },
      text: {
        type: 'string',
        description:
          'One line: what was done (complete) or why (skip, reopen). At most three lines.',
      },
    },
    required: ['action', 'stage', 'text'],
  };
}

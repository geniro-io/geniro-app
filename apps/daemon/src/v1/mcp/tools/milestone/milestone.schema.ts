import {
  MILESTONE_TEXT_MAX_CHARS,
  MilestoneKindSchema,
} from '../../../agents/chat.types';

/** `milestone`'s arguments. */
export function milestoneSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        maxLength: MILESTONE_TEXT_MAX_CHARS,
        description: `The step in plain words, one line, at most ${MILESTONE_TEXT_MAX_CHARS} characters.`,
      },
      kind: {
        type: 'string',
        enum: [...MilestoneKindSchema.options],
        default: 'progress',
        description:
          'progress — the work moved on; problem — you found something wrong; done — a piece is finished.',
      },
    },
    required: ['text'],
  };
}

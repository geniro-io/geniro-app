import {
  TEAM_NOTE_MAX_CHARS,
  TeamNoteKindSchema,
} from '../../../agents/chat.types';

/** `team_note`'s arguments. */
export function teamNoteSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: [...TeamNoteKindSchema.options],
        description:
          'contract, decision, fact, pitfall or pointer — see the tool description.',
      },
      text: {
        type: 'string',
        description: `The note, standing alone for a reader without your context; at most ${TEAM_NOTE_MAX_CHARS} characters. Markdown renders.`,
      },
      supersedes: {
        type: 'integer',
        minimum: 1,
        description:
          'The number of an earlier note of this run that this one replaces.',
      },
    },
    required: ['kind', 'text'],
  };
}

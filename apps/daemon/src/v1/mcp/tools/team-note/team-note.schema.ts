import { withSynonymProperties } from '../../../../utils/tool-arg-synonyms';
import {
  TEAM_NOTE_MAX_CHARS,
  TeamNoteKindSchema,
} from '../../../agents/chat.types';
import {
  TEAM_NOTE_SYNONYMS,
  TEAM_NOTE_WRITE_ACTIONS,
} from './team-note.reader';

/** `team_note`'s arguments. */
export function teamNoteSchema(): Record<string, unknown> {
  return withSynonymProperties(
    {
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
        title: {
          type: 'string',
          description: "Optional heading, written as the note's first line.",
        },
        action: {
          type: 'string',
          enum: [...TEAM_NOTE_WRITE_ACTIONS],
          description:
            'Leave it out — team_note always writes; team_notes reads.',
        },
        supersedes: {
          type: 'integer',
          minimum: 1,
          description:
            'The number of an earlier note of this run that this one replaces.',
        },
      },
      required: ['kind', 'text'],
    },
    TEAM_NOTE_SYNONYMS,
  );
}

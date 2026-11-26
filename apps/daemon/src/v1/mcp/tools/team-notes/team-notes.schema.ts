import {
  TEAM_NOTES_DEFAULT_LIMIT,
  TEAM_NOTES_MAX_LIMIT,
  TeamNoteKindSchema,
} from '../../../agents/chat.types';
import { withSynonymProperties } from '../../../../utils/tool-arg-synonyms';
import { TEAM_NOTES_SYNONYMS } from './team-notes.reader';

/** `team_notes`' arguments — all optional. */
export function teamNotesSchema(): Record<string, unknown> {
  return withSynonymProperties(
    {
      type: 'object',
      properties: {
        kind: {
          type: 'array',
          items: { type: 'string', enum: [...TeamNoteKindSchema.options] },
          description: 'Only notes of these kinds.',
        },
        author: {
          type: 'string',
          description: 'Only notes by this agent — its name as you know it.',
        },
        since: {
          type: 'integer',
          minimum: 0,
          description:
            'Only notes after this note number. 0 reads every note, including the ones you were already shown.',
        },
        before: {
          type: 'integer',
          minimum: 1,
          description:
            'Only notes before this note number — the value a reply hands back to fetch older ones.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: TEAM_NOTES_MAX_LIMIT,
          default: TEAM_NOTES_DEFAULT_LIMIT,
          description: `At most this many notes; more than ${TEAM_NOTES_MAX_LIMIT} reads ${TEAM_NOTES_MAX_LIMIT}.`,
        },
        include_superseded: {
          type: 'boolean',
          default: false,
          description: 'Also show notes a later note replaced, marked as such.',
        },
      },
    },
    TEAM_NOTES_SYNONYMS,
  );
}

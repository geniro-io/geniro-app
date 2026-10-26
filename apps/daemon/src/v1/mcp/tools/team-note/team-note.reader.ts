import { z } from 'zod';

import {
  TEAM_NOTE_MAX_CHARS,
  TeamNoteKindSchema,
  type TeamNoteWriteInput,
  type TeamNoteWriteOutcome,
} from '../../../agents/chat.types';
import type { HostSinkUnavailable } from '../../../agents/services/host-sink.broker';
import { readToolArgs } from '../tool-args';

/** Refused rather than cut: a note cut short can say the opposite of what was meant. */
const TeamNoteArgsSchema = z
  .object({
    kind: TeamNoteKindSchema,
    text: z
      .string()
      .trim()
      .min(1, 'text is empty')
      .max(
        TEAM_NOTE_MAX_CHARS,
        `text is over ${TEAM_NOTE_MAX_CHARS} characters — write the essentials and point to where the rest lives`,
      ),
    supersedes: z.number().int().min(1).optional(),
  })
  .strict();

/** The call's arguments, or what is wrong with them. Never throws. */
export function readTeamNote(
  args: Record<string, unknown>,
): TeamNoteWriteInput | { error: string } {
  const read = readToolArgs(TeamNoteArgsSchema, args);
  if (!read.ok) {
    return { error: read.error };
  }
  return {
    kind: read.query.kind,
    text: read.query.text,
    ...(read.query.supersedes === undefined
      ? {}
      : { supersedes: read.query.supersedes }),
  };
}

/** The receipt for a write that was not refused. */
export function teamNoteResultText(
  outcome:
    Exclude<TeamNoteWriteOutcome, { status: 'refused' }> | HostSinkUnavailable,
): string {
  if (outcome.status === 'unavailable') {
    return `Not saved: ${outcome.reason}.`;
  }
  const saved = `Saved as note ${outcome.seq}.`;
  return outcome.unread === 0
    ? saved
    : `${saved} ${outcome.unread} team ${outcome.unread === 1 ? 'note' : 'notes'} by others you have not read yet — read them with team_notes.`;
}

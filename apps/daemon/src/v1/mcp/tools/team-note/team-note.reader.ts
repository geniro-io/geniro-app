import { z } from 'zod';

import {
  applyArgSynonyms,
  type ArgSynonyms,
  leadWithCall,
} from '../../../../utils/tool-arg-synonyms';
import {
  TEAM_NOTE_MAX_CHARS,
  TeamNoteKindSchema,
  type TeamNoteWriteInput,
  type TeamNoteWriteOutcome,
} from '../../../agents/chat.types';
import type { HostSinkUnavailable } from '../../../agents/services/host-sink.broker';
import { readToolArgs } from '../tool-args';

export const TEAM_NOTE_SYNONYMS: ArgSynonyms = { message: 'text' };

/** What a first call puts in `action` when it means "write this note". */
export const TEAM_NOTE_WRITE_ACTIONS = [
  'write',
  'add',
  'set',
  'create',
  'save',
  'new',
] as const;

const TEAM_NOTE_CALL =
  'call team_note({kind: "fact", text: "<the note>"}) — team_notes reads them.';

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
  const read = readNoteArgs(args);
  if (!read.ok) {
    return { error: leadWithCall(TEAM_NOTE_CALL, read.error) };
  }
  return {
    kind: read.query.kind,
    text: read.query.text,
    ...(read.query.supersedes === undefined
      ? {}
      : { supersedes: read.query.supersedes }),
  };
}

function readNoteArgs(args: Record<string, unknown>) {
  const renamed = applyArgSynonyms(args, TEAM_NOTE_SYNONYMS);
  if (!renamed.ok) {
    return renamed;
  }
  const { action, title, ...rest } = renamed.args;
  if (
    action !== undefined &&
    action !== null &&
    !(TEAM_NOTE_WRITE_ACTIONS as readonly unknown[]).includes(action)
  ) {
    return {
      ok: false as const,
      error: `team_note only writes a note, so action ${JSON.stringify(action)} means nothing here — read notes with team_notes`,
    };
  }
  const heading = typeof title === 'string' ? title.trim() : '';
  if (title !== undefined && title !== null && typeof title !== 'string') {
    return { ok: false as const, error: 'title must be text' };
  }
  return readToolArgs(TeamNoteArgsSchema, {
    ...rest,
    text: withHeading(heading, rest.text),
  });
}

function withHeading(heading: string, text: unknown): unknown {
  if (heading === '') {
    return text;
  }
  if (text === undefined || text === null) {
    return heading;
  }
  return typeof text === 'string' ? `${heading}\n${text}` : text;
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

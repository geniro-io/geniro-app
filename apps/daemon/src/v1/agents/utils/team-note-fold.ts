import { type TeamNote, TeamNotePayloadSchema } from '../chat.types';
import { parseJsonColumn } from './json-util';

/** A stored `team_note` row as `ItemDao.teamNoteRows` projects it. */
export interface TeamNoteRow {
  seq: number;
  payload: string;
  createdAt: Date;
}

/**
 * A run's team notes with every supersede pair folded in, oldest first.
 *
 * A row whose payload does not parse is left out: it names no kind or text a
 * reader could act on. A supersede is honoured only when it names an EARLIER
 * readable note, so a later write can never hide a note it could not have
 * read; when several notes supersede one, the newest of them is the one named.
 */
export function foldTeamNotes(rows: readonly TeamNoteRow[]): TeamNote[] {
  const notes: TeamNote[] = [];
  const bySeq = new Map<number, TeamNote>();
  for (const row of rows) {
    const parsed = TeamNotePayloadSchema.safeParse(
      parseJsonColumn(row.payload),
    );
    if (!parsed.success) {
      continue;
    }
    const payload = parsed.data;
    const replaced =
      payload.supersedes === undefined
        ? undefined
        : bySeq.get(payload.supersedes);
    const note: TeamNote = {
      seq: row.seq,
      kind: payload.kind,
      text: payload.text,
      memberId: payload.nodeId,
      conversationId: payload.conversationId,
      callId: payload.callId ?? null,
      createdAt: row.createdAt.toISOString(),
      supersedes:
        replaced !== undefined && replaced.seq < row.seq ? replaced.seq : null,
      supersededBy: null,
    };
    if (note.supersedes !== null && replaced !== undefined) {
      replaced.supersededBy = row.seq;
    }
    notes.push(note);
    bySeq.set(note.seq, note);
  }
  return notes;
}

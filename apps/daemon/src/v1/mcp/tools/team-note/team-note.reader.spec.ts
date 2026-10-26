import { describe, expect, it } from 'vitest';

import { TEAM_NOTE_MAX_CHARS } from '../../../agents/chat.types';
import { readTeamNote, teamNoteResultText } from './team-note.reader';

describe('readTeamNote', () => {
  it('reads a kind, trimmed text and an optional supersedes', () => {
    expect(
      readTeamNote({ kind: 'decision', text: '  use gRPC  ', supersedes: 12 }),
    ).toEqual({ kind: 'decision', text: 'use gRPC', supersedes: 12 });
    expect(readTeamNote({ kind: 'fact', text: 'x', supersedes: null })).toEqual(
      { kind: 'fact', text: 'x' },
    );
  });

  it('refuses an unknown kind, empty or overlong text, a bad supersedes and unknown arguments', () => {
    const error = (args: Record<string, unknown>): string => {
      const read = readTeamNote(args);
      if (!('error' in read)) {
        throw new Error(`expected a refusal for ${JSON.stringify(args)}`);
      }
      return read.error;
    };
    expect(error({ kind: 'progress', text: 'x' })).toContain('kind');
    expect(error({ kind: 'fact', text: '   ' })).toContain('text is empty');
    expect(
      error({ kind: 'fact', text: 'x'.repeat(TEAM_NOTE_MAX_CHARS + 1) }),
    ).toContain(`over ${TEAM_NOTE_MAX_CHARS} characters`);
    expect(error({ kind: 'fact', text: 'x', supersedes: 0 })).toContain(
      'supersedes',
    );
    expect(error({ kind: 'fact', text: 'x', to: 'all' })).toContain('to');
  });
});

describe('teamNoteResultText', () => {
  it('names the note and says how many notes by others are unread', () => {
    expect(teamNoteResultText({ status: 'written', seq: 128, unread: 0 })).toBe(
      'Saved as note 128.',
    );
    expect(teamNoteResultText({ status: 'written', seq: 128, unread: 2 })).toBe(
      'Saved as note 128. 2 team notes by others you have not read yet — read them with team_notes.',
    );
  });

  it('says it was not saved when no pass could record it', () => {
    expect(
      teamNoteResultText({ status: 'unavailable', reason: 'no pass' }),
    ).toBe('Not saved: no pass.');
  });
});

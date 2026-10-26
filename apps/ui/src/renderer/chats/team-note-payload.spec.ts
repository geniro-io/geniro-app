import { describe, expect, it } from 'vitest';

import { readTeamNotePayload } from './team-note-payload';

describe('readTeamNotePayload', () => {
  it('reads a note, defaulting the optional fields to null', () => {
    expect(
      readTeamNotePayload({
        kind: 'decision',
        text: 'use gRPC',
        nodeId: 'engineer',
        conversationId: null,
      }),
    ).toEqual({
      kind: 'decision',
      text: 'use gRPC',
      supersedes: null,
      nodeId: 'engineer',
      conversationId: null,
      callId: null,
    });
    expect(
      readTeamNotePayload({
        kind: 'fact',
        text: 'x',
        nodeId: 'n',
        conversationId: 'call-2',
        callId: 'call-2',
        supersedes: 7,
      }),
    ).toMatchObject({
      supersedes: 7,
      conversationId: 'call-2',
      callId: 'call-2',
    });
  });

  it('answers null for a payload that is not a team note', () => {
    expect(readTeamNotePayload(null)).toBeNull();
    expect(
      readTeamNotePayload({ kind: 'progress', text: 'x', nodeId: 'n' }),
    ).toBeNull();
    expect(readTeamNotePayload({ kind: 'fact', nodeId: 'n' })).toBeNull();
    expect(readTeamNotePayload({ kind: 'fact', text: 'x' })).toBeNull();
  });
});

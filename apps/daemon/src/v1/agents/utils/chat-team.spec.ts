import { describe, expect, it } from 'vitest';

import type { Run } from '../../runs/entity/run.entity';
import { chatTeamSizeOf, readTeamDepartures } from './chat-team';

const snapshot = (ids: string[]): string =>
  JSON.stringify({ members: ids.map((id) => ({ id })) });

function chatTeamRun(
  overrides: Partial<
    Pick<Run, 'teamOrigin' | 'teamSnapshot' | 'teamDeparted'>
  > = {},
): Pick<Run, 'teamOrigin' | 'teamSnapshot' | 'teamDeparted'> {
  return {
    teamOrigin: 'chat',
    teamSnapshot: snapshot(['agent', 'dev', 'qa']),
    teamDeparted: null,
    ...overrides,
  };
}

describe('readTeamDepartures', () => {
  it('reads no departures from an absent column', () => {
    expect(readTeamDepartures(null)).toEqual([]);
  });

  it('reads no departures from a column that is not JSON', () => {
    expect(readTeamDepartures('{not json')).toEqual([]);
  });

  it('reads no departures from JSON of another shape', () => {
    expect(readTeamDepartures('{"memberId":"qa"}')).toEqual([]);
  });

  it('reads each departure its column holds', () => {
    expect(
      readTeamDepartures(
        JSON.stringify([
          { memberId: 'qa', leftAt: '2026-11-25T10:00:00.000Z' },
        ]),
      ),
    ).toEqual([{ memberId: 'qa', leftAt: '2026-11-25T10:00:00.000Z' }]);
  });
});

describe('chatTeamSizeOf', () => {
  it('is null for a run that is not a chat team', () => {
    expect(chatTeamSizeOf(chatTeamRun({ teamOrigin: null }))).toBeNull();
  });

  it('is null for a chat team run with no team copy to count', () => {
    expect(chatTeamSizeOf(chatTeamRun({ teamSnapshot: null }))).toBeNull();
  });

  it("counts the members beside the chat's own agent", () => {
    expect(chatTeamSizeOf(chatTeamRun())).toBe(2);
  });

  it('leaves out the members who have departed', () => {
    expect(
      chatTeamSizeOf(
        chatTeamRun({
          teamDeparted: JSON.stringify([
            { memberId: 'qa', leftAt: '2026-11-25T10:00:00.000Z' },
          ]),
        }),
      ),
    ).toBe(1);
  });

  it('counts a member added mid-run, which is in the copy and not departed', () => {
    expect(
      chatTeamSizeOf(
        chatTeamRun({ teamSnapshot: snapshot(['agent', 'dev', 'qa', 'new']) }),
      ),
    ).toBe(3);
  });
});

import { describe, expect, it } from 'vitest';

import { member, teamOf } from '../__tests__/team-builders';
import { assertValidTeam, validateTeam } from './team-validate';

const codes = (issues: { code: string }[]): string[] =>
  issues.map((issue) => issue.code);

describe('validateTeam', () => {
  it('accepts a team with members, one trigger naming one of them and no stages', () => {
    expect(validateTeam(teamOf([member('lead'), member('qa')]))).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it('requires at least one member', () => {
    expect(codes(validateTeam(teamOf([])).errors)).toContain('TEAM_NO_MEMBERS');
  });

  it('refuses two members sharing an id', () => {
    const { errors } = validateTeam(teamOf([member('a'), member('a')]));

    expect(errors).toContainEqual({
      code: 'TEAM_DUPLICATE_MEMBER',
      message: 'Duplicate member id(s): a',
    });
  });

  it('requires exactly one trigger', () => {
    const none = teamOf([member('a')], { triggers: [] });
    const two = teamOf([member('a'), member('b')], {
      triggers: [
        { kind: 'first-message', member: 'a' },
        { kind: 'first-message', member: 'b' },
      ],
    });

    expect(codes(validateTeam(none).errors)).toEqual(['TEAM_TRIGGER_COUNT']);
    expect(codes(validateTeam(two).errors)).toEqual(['TEAM_TRIGGER_COUNT']);
  });

  it('refuses a trigger naming no member', () => {
    const { errors } = validateTeam(
      teamOf([member('a')], {
        triggers: [{ kind: 'first-message', member: 'ghost' }],
      }),
    );

    expect(codes(errors)).toEqual(['TEAM_TRIGGER_UNKNOWN']);
  });

  it('refuses two blocks sharing an id', () => {
    const block = {
      id: 'b',
      title: 'B',
      text: 'x',
      audience: 'everyone' as const,
    };
    const { errors } = validateTeam(
      teamOf([member('a')], { instructionBlocks: [block, block] }),
    );

    expect(codes(errors)).toEqual(['TEAM_DUPLICATE_BLOCK']);
  });

  it('warns about an audience id that is no member, without refusing the team', () => {
    const { errors, warnings } = validateTeam(
      teamOf([member('a')], {
        instructionBlocks: [
          { id: 'b', title: 'B', text: 'x', audience: ['a', 'gone'] },
        ],
      }),
    );

    expect(errors).toEqual([]);
    expect(codes(warnings)).toEqual(['TEAM_AUDIENCE_UNKNOWN']);
  });

  it("warns about a stage's responsible id that is no member, and refuses a stage graph that cannot be walked", () => {
    const warned = validateTeam(
      teamOf([member('a')], {
        stages: [
          { id: 'one', title: 'One', goal: 'done', responsible: ['nobody'] },
        ],
      }),
    );
    const looped = validateTeam(
      teamOf([member('a')], {
        stages: [
          { id: 'one', title: 'One', goal: 'g', next: ['two'] },
          { id: 'two', title: 'Two', goal: 'g', next: ['one'] },
        ],
      }),
    );

    expect(warned.errors).toEqual([]);
    expect(codes(warned.warnings)).toEqual(['STAGE_RESPONSIBLE_UNKNOWN']);
    expect(codes(looped.errors)).toEqual(['STAGE_NO_START']);
  });
});

describe('assertValidTeam', () => {
  it('throws the first error with its code', () => {
    expect(() => assertValidTeam(teamOf([]))).toThrow(
      expect.objectContaining({ errorCode: 'TEAM_NO_MEMBERS' }),
    );
  });

  it('lets a team with only warnings through', () => {
    expect(() =>
      assertValidTeam(
        teamOf([member('a')], {
          instructionBlocks: [
            { id: 'b', title: 'B', text: 'x', audience: ['gone'] },
          ],
        }),
      ),
    ).not.toThrow();
  });
});

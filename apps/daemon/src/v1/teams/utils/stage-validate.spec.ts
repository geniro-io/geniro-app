import { BadRequestException } from '@packages/common';
import { describe, expect, it } from 'vitest';

import { member, teamOf } from '../__tests__/team-builders';
import type { Team, TeamStage } from '../teams.types';
import {
  assertValidStages,
  startStageId,
  validateStages,
} from './stage-validate';
import { checkTeam } from './team-check';

const stage = (
  id: string,
  next?: string[],
  over: Partial<TeamStage> = {},
): TeamStage => ({
  id,
  title: id,
  goal: `${id} is done`,
  ...(next ? { next } : {}),
  ...over,
});

const teamWith = (stages: TeamStage[] | undefined): Team =>
  teamOf([member('lead')], stages ? { stages } : {});

const codes = (stages: TeamStage[]): string[] =>
  validateStages(teamWith(stages)).errors.map((e) => e.code);

const FORK = [
  stage('investigation', ['implementation', 'fix']),
  stage('implementation', ['review']),
  stage('fix', ['review']),
  stage('review', ['done']),
  stage('done'),
];

describe('validateStages', () => {
  it('accepts a fork and no stages at all', () => {
    expect(validateStages(teamWith(FORK))).toEqual({
      errors: [],
      warnings: [],
    });
    expect(validateStages(teamWith(undefined)).errors).toEqual([]);
    expect(validateStages(teamWith([])).errors).toEqual([]);
  });

  it('rejects a cycle, two starts and a graph with no start', () => {
    expect(
      codes([stage('a', ['b']), stage('b', ['c']), stage('c', ['b'])]),
    ).toEqual(['STAGE_CYCLE']);
    expect(codes([stage('a', ['c']), stage('b', ['c']), stage('c')])).toEqual([
      'STAGE_MULTIPLE_STARTS',
    ]);
    expect(
      codes([
        stage('a', ['b']),
        stage('b'),
        stage('c', ['d']),
        stage('d', ['c']),
      ]),
    ).toEqual(['STAGE_CYCLE']);
    expect(codes([stage('a', ['a'])])).toEqual(['STAGE_NO_START']);
  });

  it('rejects duplicate ids, unknown and repeated next stages, and too many stages', () => {
    expect(codes([stage('a'), stage('a')])).toEqual(['STAGE_DUPLICATE_ID']);
    expect(codes([stage('a', ['ghost'])])).toEqual(['STAGE_NEXT_UNKNOWN']);
    expect(codes([stage('a', ['b', 'b']), stage('b')])).toEqual([
      'STAGE_NEXT_DUPLICATE',
    ]);
    const many = Array.from({ length: 21 }, (_, i) =>
      stage(`s${i}`, i < 20 ? [`s${i + 1}`] : undefined),
    );
    expect(codes(many)).toEqual(['STAGE_TOO_MANY']);
  });

  it('warns, not fails, on a responsible id naming no member', () => {
    const unknown = teamWith([
      stage('a', undefined, { responsible: ['lead', 'deleted-member'] }),
    ]);
    const result = validateStages(unknown);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => [w.code, w.stageId])).toEqual([
      ['STAGE_RESPONSIBLE_UNKNOWN', 'a'],
    ]);
    expect(() => assertValidStages(unknown)).not.toThrow();
  });

  it('does not warn when every responsible id is a member', () => {
    const result = validateStages(
      teamWith([stage('a', undefined, { responsible: ['lead'] })]),
    );
    expect(result.warnings).toEqual([]);
  });
});

describe('assertValidStages', () => {
  it('throws the first error with its code', () => {
    try {
      assertValidStages(teamWith([stage('a', ['b']), stage('b', ['a'])]));
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).errorCode).toBe('STAGE_NO_START');
    }
  });
});

describe('checkTeam', () => {
  it('refuses a team whose stages cannot be walked', () => {
    const result = checkTeam(
      teamWith([stage('a', ['b']), stage('b', ['c']), stage('c', ['b'])]),
    );
    expect(result).toMatchObject({ ok: false, code: 'STAGE_CYCLE' });
  });
});

describe('startStageId', () => {
  it('is the stage no other stage names', () => {
    expect(startStageId(FORK)).toBe('investigation');
  });
});

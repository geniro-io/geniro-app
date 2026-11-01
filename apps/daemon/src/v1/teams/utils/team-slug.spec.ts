import { describe, expect, it } from 'vitest';

import {
  isReservedTeamSlug,
  RESERVED_TEAM_SLUGS,
  slugifyTeamName,
} from './team-slug';

describe('slugifyTeamName', () => {
  it('lowercases and dashes a name', () => {
    expect(slugifyTeamName('Review Team')).toBe('review-team');
  });

  it('falls back to `team` for a name with nothing usable in it', () => {
    expect(slugifyTeamName('***')).toBe('team');
  });
});

describe('RESERVED_TEAM_SLUGS', () => {
  // `GET /v1/teams/runs` is the run list, `POST /v1/teams/import`
  // the importer and `POST /v1/teams/instruction-sizes` the inspector's
  // size readout — static routes Fastify matches before `:slug`.
  it('reserves the static segments the teams controller owns', () => {
    expect([...RESERVED_TEAM_SLUGS].sort()).toEqual([
      'import',
      'instruction-sizes',
      'runs',
    ]);
    expect(isReservedTeamSlug('runs')).toBe(true);
    expect(isReservedTeamSlug('import')).toBe(true);
    expect(isReservedTeamSlug('runs-1')).toBe(false);
  });
});

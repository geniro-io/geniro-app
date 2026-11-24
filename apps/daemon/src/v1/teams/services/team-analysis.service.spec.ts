import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NotFoundException } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ThreadAnalysisService } from '../../agents/services/thread-analysis.service';
import { member, teamOf } from '../__tests__/team-builders';
import type { Team } from '../teams.types';
import { TeamAnalysisService } from './team-analysis.service';
import { TeamStoreService } from './team-store.service';

const WF: Team = teamOf([member('lead')], { name: 'Review Team' });

describe('TeamAnalysisService', () => {
  let dir: string;
  let store: TeamStoreService;
  let analyses: {
    startTeam: ReturnType<typeof vi.fn>;
    findTeamAnalysis: ReturnType<typeof vi.fn>;
    countTeamRunsInPeriod: ReturnType<typeof vi.fn>;
    deleteTeamAnalyses: ReturnType<typeof vi.fn>;
    analysedTeamSlugs: ReturnType<typeof vi.fn>;
  };
  let service: TeamAnalysisService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geniro-team-analysis-'));
    store = new TeamStoreService({ teamsDir: dir });
    analyses = {
      startTeam: vi.fn().mockResolvedValue({ id: 'analysis' }),
      findTeamAnalysis: vi.fn().mockResolvedValue(null),
      countTeamRunsInPeriod: vi
        .fn()
        .mockResolvedValue({ inPeriod: 3, analysed: 3 }),
      deleteTeamAnalyses: vi.fn().mockResolvedValue(undefined),
      analysedTeamSlugs: vi.fn().mockResolvedValue([]),
    };
    service = new TeamAnalysisService(
      store,
      analyses as unknown as ThreadAnalysisService,
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts the analysis with the team’s name', async () => {
    const { slug } = await store.create(WF);

    await service.start(slug, { agentKind: 'claude', days: 7 });

    expect(analyses.startTeam).toHaveBeenCalledWith(
      { slug, name: 'Review Team' },
      { agentKind: 'claude', days: 7 },
    );
  });

  it('refuses a team the library does not hold, before touching any analysis', async () => {
    await expect(
      service.start('no-such-team', { agentKind: 'claude', days: 7 }),
    ).rejects.toThrow(NotFoundException);
    await expect(service.find('no-such-team')).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.count('no-such-team', 7)).rejects.toThrow(
      NotFoundException,
    );
    expect(analyses.startTeam).not.toHaveBeenCalled();
    expect(analyses.findTeamAnalysis).not.toHaveBeenCalled();
    expect(analyses.countTeamRunsInPeriod).not.toHaveBeenCalled();
  });

  it('counts the team’s runs in the period through the analyses that start it', async () => {
    const { slug } = await store.create(WF);
    analyses.countTeamRunsInPeriod.mockResolvedValue({
      inPeriod: 45,
      analysed: 30,
    });

    await expect(service.count(slug, 30)).resolves.toEqual({
      inPeriod: 45,
      analysed: 30,
    });
    expect(analyses.countTeamRunsInPeriod).toHaveBeenCalledWith(slug, 30);
  });

  it('sweeps the analyses of teams the library no longer holds, and only those', async () => {
    const { slug } = await store.create(WF);
    analyses.analysedTeamSlugs.mockResolvedValue([
      slug,
      'deleted-team',
      '../not-a-slug',
    ]);

    await service.sweepOrphans();

    expect(analyses.deleteTeamAnalyses.mock.calls).toEqual([
      ['deleted-team'],
      ['../not-a-slug'],
    ]);
  });
});

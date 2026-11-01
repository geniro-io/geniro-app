import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NotFoundException } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunWire } from '../../agents/chat.types';
import type { ThreadAnalysisService } from '../../agents/services/thread-analysis.service';
import type { Team } from '../teams.types';
import { TeamAnalysisService } from './team-analysis.service';
import { TeamStoreService } from './team-store.service';

const WF: Team = {
  name: 'Review Team',
  nodes: [{ id: 'start', kind: 'trigger', trigger: 'manual' }],
  edges: [],
};

describe('TeamAnalysisService', () => {
  let dir: string;
  let store: TeamStoreService;
  let analyses: {
    startTeam: ReturnType<typeof vi.fn>;
    findTeamAnalysis: ReturnType<typeof vi.fn>;
    deleteTeamAnalyses: ReturnType<typeof vi.fn>;
    analysedTeamSlugs: ReturnType<typeof vi.fn>;
  };
  let service: TeamAnalysisService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geniro-team-analysis-'));
    store = new TeamStoreService({ teamsDir: dir });
    analyses = {
      startTeam: vi.fn().mockResolvedValue({ id: 'analysis' } as RunWire),
      findTeamAnalysis: vi.fn().mockResolvedValue(null),
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

    await service.start(slug, { agentKind: 'claude', runs: 5 });

    expect(analyses.startTeam).toHaveBeenCalledWith(
      { slug, name: 'Review Team' },
      { agentKind: 'claude', runs: 5 },
    );
  });

  it('refuses a team the library does not hold, before touching any analysis', async () => {
    await expect(
      service.start('no-such-team', { agentKind: 'claude', runs: 5 }),
    ).rejects.toThrow(NotFoundException);
    await expect(service.find('no-such-team')).rejects.toThrow(
      NotFoundException,
    );
    expect(analyses.startTeam).not.toHaveBeenCalled();
    expect(analyses.findTeamAnalysis).not.toHaveBeenCalled();
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

import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it, vi } from 'vitest';

import type { RunDao } from '../../agents/dao/run.dao';
import type { Run } from '../../runs/entity/run.entity';
import { member, teamOf } from '../__tests__/team-builders';
import type { Team } from '../teams.types';
import { teamSnapshotOf } from '../utils/team-snapshot';
import { RunTeamService } from './run-team.service';
import type { TeamStoreService } from './team-store.service';

// Schema-VALID on purpose: a copy the schema cannot read is REFUSED (see the
// cases below), so an invalid fixture would fail the "reads its own copy"
// cases for a reason that has nothing to do with them.
const teamWith = (instructions: string): Team =>
  teamOf([member('engineer', { instructions })], { name: 'Dev Team' });

function doubles(library: Team, stored: Partial<Run> | null) {
  const updates: { id: string; data: Partial<Run> }[] = [];
  const runDao = {
    getById: vi.fn(async () => stored),
    updateWithoutActivity: vi.fn(async (id: string, data: Partial<Run>) => {
      updates.push({ id, data });
      return 1;
    }),
  } as unknown as RunDao;
  const get = vi.fn(async (slug: string) => ({ slug, team: library }));
  const store = { get } as unknown as TeamStoreService;
  const em = { fork: () => ({}) } as unknown as EntityManager;
  return { service: new RunTeamService(em, runDao, store), updates, get };
}

describe('RunTeamService', () => {
  it('answers with the run’s OWN copy, whatever the library now says', async () => {
    // The reported defect: editing the team changed every run made from it.
    const { service, get } = doubles(teamWith('edited since'), null);
    const run = {
      id: 'run-1',
      teamId: 'dev-team',
      teamSnapshot: teamSnapshotOf(teamWith('as it started')),
    };

    const kept = await service.teamOf(run);

    expect(kept.members.find((m) => m.id === 'engineer')).toMatchObject({
      instructions: 'as it started',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('FREEZES a run that kept no copy on its first read, and reads the library once', async () => {
    const { service, updates, get } = doubles(teamWith('library today'), null);
    const run: Pick<Run, 'id' | 'teamSnapshot'> & { teamId: string } = {
      id: 'run-old',
      teamId: 'dev-team',
      teamSnapshot: null,
    };

    const first = await service.teamOf(run);
    expect(first.members.find((m) => m.id === 'engineer')).toMatchObject({
      instructions: 'library today',
    });
    expect(updates).toEqual([
      {
        id: 'run-old',
        data: { teamSnapshot: teamSnapshotOf(teamWith('library today')) },
      },
    ]);
    // The object it was handed carries the copy now, so a later read of the
    // same run is served from it even after the library changes.
    expect(run.teamSnapshot).not.toBeNull();
    get.mockResolvedValue({
      slug: 'dev-team',
      team: teamWith('edited later'),
    });
    const second = await service.teamOf(run);
    expect(second.members.find((m) => m.id === 'engineer')).toMatchObject({
      instructions: 'library today',
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  /**
   * An unreadable copy is still the team the run STARTED with. Read as "no
   * copy yet", it would be overwritten with the library's current team,
   * so the run would go on under its old name running whatever the library
   * holds today — and the only record of what it did run would be destroyed
   * doing it.
   */
  describe('a copy the current schema cannot read', () => {
    it.each([
      ['a shape this build does not know', '{"not":"a team"}'],
      ['text that is not JSON at all', '{"name": "Dev Team", "nodes": ['],
    ])(
      '%s is refused, never replaced from the library',
      async (_label, raw) => {
        const { service, updates, get } = doubles(
          teamWith('library today'),
          null,
        );
        const run = {
          id: 'run-2',
          teamId: 'dev-team',
          teamSnapshot: raw,
        };

        await expect(service.teamOf(run)).rejects.toMatchObject({
          errorCode: 'TEAM_SNAPSHOT_UNREADABLE',
        });

        expect(updates).toEqual([]);
        expect(get).not.toHaveBeenCalled();
        expect(run.teamSnapshot).toBe(raw);
      },
    );

    it('says which run and what could not be read', async () => {
      const { service } = doubles(teamWith('library today'), null);

      await expect(
        service.teamOf({
          id: 'run-2',
          teamId: 'dev-team',
          teamSnapshot: '{"not":"a team"}',
        }),
      ).rejects.toThrow(/run-2.*cannot be read/);
    });
  });

  it('reads a copy kept while teams were node graphs as the converted team, never refusing it', async () => {
    const legacyGraph = {
      name: 'Dev Team',
      nodes: [
        { id: 'start', kind: 'trigger', trigger: 'manual' },
        {
          id: 'engineer',
          kind: 'agent',
          agent: 'claude',
          approval: 'auto',
          description: 'builds it',
          role: 'as it started',
        },
      ],
      edges: [{ from: 'start', to: 'engineer', kind: 'data' }],
    };
    const { service, updates, get } = doubles(teamWith('library today'), null);
    const run = {
      id: 'run-graph',
      teamId: 'dev-team',
      teamSnapshot: JSON.stringify(legacyGraph),
    };

    const read = await service.teamOf(run);

    expect(read).toMatchObject({
      name: 'Dev Team',
      mode: 'lead',
      members: [
        {
          id: 'engineer',
          name: 'engineer',
          role: 'builds it',
          instructions: 'as it started',
        },
      ],
      triggers: [{ kind: 'first-message', member: 'engineer' }],
    });
    expect(updates).toEqual([]);
    expect(get).not.toHaveBeenCalled();
    expect(run.teamSnapshot).toBe(JSON.stringify(legacyGraph));
  });

  it('serves the route from the run row, and refuses a chat run', async () => {
    const teamRun = {
      id: 'run-3',
      teamId: 'dev-team',
      teamSnapshot: teamSnapshotOf(teamWith('kept')),
    } as Run;
    const { service } = doubles(teamWith('library'), teamRun);
    await expect(service.snapshotOfRun('run-3')).resolves.toMatchObject({
      team: { name: 'Dev Team' },
    });

    const chat = { id: 'chat-1', teamId: null } as Run;
    const { service: forChat } = doubles(teamWith('library'), chat);
    await expect(forChat.snapshotOfRun('chat-1')).rejects.toThrow();
  });
});

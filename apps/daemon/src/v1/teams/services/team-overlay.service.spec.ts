import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectDao } from '../../projects/dao/project.dao';
import { ProjectEventBus } from '../../projects/services/project-events.bus';
import { member, teamOf } from '../__tests__/team-builders';
import { configDirToken } from '../utils/config-dir-redaction';
import { TeamOverlayService } from './team-overlay.service';
import { TeamOverlayStoreService } from './team-overlay-store.service';
import { TeamStoreService } from './team-store.service';

interface FakeProject {
  id: string;
  name: string;
  teamSlug: string | null;
}

describe('TeamOverlayService', () => {
  let dir: string;
  let store: TeamStoreService;
  let overlays: TeamOverlayStoreService;
  let projects: Map<string, FakeProject>;
  let events: ProjectEventBus;
  let service: TeamOverlayService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geniro-overlay-service-'));
    store = new TeamStoreService({ teamsDir: dir });
    overlays = new TeamOverlayStoreService({ teamsDir: dir });
    projects = new Map();
    events = new ProjectEventBus();
    const dao = {
      getById: async (id: string) => projects.get(id) ?? null,
      listAll: async () => [...projects.values()],
    } as unknown as ProjectDao;
    service = new TeamOverlayService(
      overlays,
      store,
      dao,
      { fork: () => ({}) } as never,
      events,
    );
    await store.create(
      teamOf(
        [member('lead', { instructions: 'Plan it.' }), member('reviewer')],
        {
          name: 'Dev',
          instructionBlocks: [
            {
              id: 'b1',
              title: 'Shared',
              text: 'Be brief.',
              audience: 'everyone',
            },
          ],
        },
      ),
      'dev',
    );
    await store.create(teamOf([member('solo')], { name: 'Ops' }), 'ops');
    projects.set('p1', { id: 'p1', name: 'Geniro', teamSlug: 'dev' });
    projects.set('p2', { id: 'p2', name: 'Manifest', teamSlug: 'ops' });
    projects.set('p3', { id: 'p3', name: 'Site', teamSlug: null });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists projects defaulting to the team, then inactive overlays naming what they now default to', async () => {
    await service.save(
      'dev',
      'p1',
      { members: { lead: { settings: { effort: 'max' } } } },
      null,
    );
    await service.save('dev', 'p2', { instructionBlocks: [] }, null);

    const scopes = await service.scopes('dev');

    expect(
      scopes.map((s) => [s.projectName, s.active, s.defaultTeamName]),
    ).toEqual([
      ['Geniro', true, 'Dev'],
      ['Manifest', false, 'Ops'],
    ]);
    expect(scopes[0]).toMatchObject({ hasOverlay: true, overrides: 1 });
  });

  it('applies the overlay only to the project’s default team', async () => {
    await service.save(
      'dev',
      'p1',
      { members: { lead: { settings: { effort: 'max' } } } },
      null,
    );
    await service.save(
      'dev',
      'p2',
      { members: { lead: { settings: { effort: 'max' } } } },
      null,
    );

    const inDefault = await service.effectiveBySlug('dev', 'p1');
    const elsewhere = await service.effectiveBySlug('dev', 'p2');
    const none = await service.effectiveBySlug('dev', null);

    expect(inDefault.team.members[0]!.effort).toBe('max');
    expect(inDefault.overlay).toMatchObject({ projectId: 'p1' });
    expect(elsewhere.team.members[0]!.effort).toBeUndefined();
    expect(elsewhere.overlay).toBeNull();
    expect(none.overlay).toBeNull();
  });

  it('refuses a save that would not run and writes nothing', async () => {
    await expect(
      service.save(
        'dev',
        'p1',
        { members: { lead: { settings: { agent: 'codex', model: '' } } } },
        null,
      ),
    ).rejects.toMatchObject({ errorCode: 'TEAM_OVERLAY_INVALID' });
    expect(await overlays.get('dev', 'p1')).toBeNull();
  });

  it('reports orphans on read', async () => {
    await overlays.save('dev', 'p1', {
      members: { gone: { extraInstructions: 'x' } },
    });

    expect((await service.get('dev', 'p1')).orphans).toEqual(['members.gone']);
  });

  it('removes a deleted project’s overlays when the project event says so', async () => {
    service.onModuleInit();
    await overlays.save('dev', 'p3', {});
    await overlays.save('ops', 'p3', {});

    events.publish({ projectId: 'p3' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await overlays.listForProject('p3')).toEqual(['dev', 'ops']);

    projects.delete('p3');
    events.publish({ projectId: 'p3' });
    await vi.waitFor(async () => {
      expect(await overlays.listForProject('p3')).toEqual([]);
    });
    service.onModuleDestroy();
  });

  it('lists every team’s overlay a project holds, its default team’s first', async () => {
    await overlays.save('ops', 'p1', {
      members: { solo: { extraInstructions: 'kept' } },
    });
    await overlays.save('dev', 'p1', {
      instructionBlocks: [
        { id: 'x', title: 'P', text: 'Project rule', audience: 'everyone' },
      ],
    });

    expect(await service.forProject('p1')).toMatchObject([
      { slug: 'dev', teamName: 'Dev', active: true, blocks: 1 },
      { slug: 'ops', teamName: 'Ops', active: false, notes: 1 },
    ]);
    expect(await service.forProject('p3')).toEqual([]);
  });

  it('sweeps at boot the overlays of projects deleted while the daemon was down', async () => {
    await overlays.save('dev', 'p1', {});
    await overlays.save('dev', 'gone', {});
    await overlays.save('ops', 'gone', {});
    await overlays.save('ops', 'p2', {});

    service.onApplicationBootstrap();
    await vi.waitFor(async () => {
      expect(await overlays.listForProject('gone')).toEqual([]);
    });
    expect(await overlays.listForTeam('dev')).toEqual(['p1']);
    expect(await overlays.listForTeam('ops')).toEqual(['p2']);
  });

  it('checks a proposed overlay against the team and diffs it from the file', async () => {
    const { team } = await store.get('dev');
    await overlays.save('dev', 'p1', {
      members: { lead: { settings: { effort: 'low' } } },
    });

    const ok = await service.prepareChange('dev', team, 'p1', {
      members: { lead: { settings: { effort: 'max' } } },
    });
    expect(ok).toMatchObject({
      ok: true,
      current: {
        overlay: { members: { lead: { settings: { effort: 'low' } } } },
      },
    });
    expect(ok.ok && ok.effective.members[0]!.effort).toBe('max');
    expect(ok.ok && ok.diffText).toContain('effort');

    expect(await service.prepareChange('dev', team, 'p2', {})).toMatchObject({
      ok: false,
      code: 'OVERLAY_INACTIVE',
    });
    expect(
      await service.prepareChange('dev', team, 'p1', { members: 3 }),
    ).toMatchObject({ ok: false, code: 'TEAM_OVERLAY_INVALID' });
  });

  it('puts a read_teams token back to the profile it names, and refuses one naming none', async () => {
    const team = teamOf([
      member('lead', { agent: 'claude', configDir: '/profiles/work' }),
    ]);
    const proposed = (configDir: string) => ({
      members: { lead: { pool: [{ agent: 'claude' as const, configDir }] } },
    });

    const restored = await service.prepareChange(
      'dev',
      team,
      'p1',
      proposed(configDirToken('/profiles/work')),
      { tokens: true },
    );
    expect(restored.ok && restored.overlay.members!.lead!.pool).toEqual([
      { agent: 'claude', configDir: '/profiles/work' },
    ]);
    expect(
      await service.prepareChange(
        'dev',
        team,
        'p1',
        proposed(configDirToken('/profiles/other')),
        { tokens: true },
      ),
    ).toMatchObject({ ok: false, code: 'CONFIG_DIR_UNKNOWN' });
    expect(
      await service.prepareChange(
        'dev',
        teamOf([
          member('lead', { agent: 'codex', configDir: '/profiles/work' }),
        ]),
        'p1',
        proposed(configDirToken('/profiles/work')),
        { tokens: true },
      ),
    ).toMatchObject({ ok: false, code: 'CONFIG_DIR_UNKNOWN' });
  });

  it('writes the overlay and then the team, putting the overlay back when the team write fails', async () => {
    const before = await overlays.save('dev', 'p1', {
      members: { lead: { extraInstructions: 'old' } },
    });

    await expect(
      service.writeWithTeam(
        'dev',
        'p1',
        { members: { lead: { extraInstructions: 'new' } } },
        before.hash,
        () => Promise.reject(new Error('team write failed')),
      ),
    ).rejects.toThrow('team write failed');
    expect((await overlays.get('dev', 'p1'))!.hash).toBe(before.hash);

    const restoreFails = vi
      .spyOn(overlays, 'restore')
      .mockRejectedValueOnce(new Error('disk gone'));
    await expect(
      service.writeWithTeam(
        'dev',
        'p1',
        { members: { lead: { extraInstructions: 'newer' } } },
        before.hash,
        () => Promise.reject(new Error('team write failed')),
      ),
    ).rejects.toThrow('team write failed');
    restoreFails.mockRestore();

    const meanwhile = await overlays.get('dev', 'p1');
    await expect(
      service.writeWithTeam(
        'dev',
        'p1',
        { members: { lead: { extraInstructions: 'mine' } } },
        meanwhile!.hash,
        async () => {
          const written = await overlays.get('dev', 'p1');
          await overlays.save(
            'dev',
            'p1',
            { members: { lead: { extraInstructions: 'typed meanwhile' } } },
            written!.hash,
          );
          throw new Error('team write failed');
        },
      ),
    ).rejects.toThrow('team write failed');
    expect(
      (await overlays.get('dev', 'p1'))!.overlay.members!.lead!
        .extraInstructions,
    ).toBe('typed meanwhile');

    const written = await service.writeWithTeam(
      'dev',
      'p1',
      { members: { lead: { extraInstructions: 'new' } } },
      (await overlays.get('dev', 'p1'))!.hash,
      () => Promise.resolve('team-saved'),
    );
    expect(written.team).toBe('team-saved');
    expect((await overlays.get('dev', 'p1'))!.hash).toBe(written.overlay.hash);
  });
});

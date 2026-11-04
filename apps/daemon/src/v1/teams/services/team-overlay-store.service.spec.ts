import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TeamOverlayStoreService } from './team-overlay-store.service';

describe('TeamOverlayStoreService', () => {
  let dir: string;
  let store: TeamOverlayStoreService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geniro-overlays-'));
    store = new TeamOverlayStoreService({ teamsDir: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const backups = async (): Promise<string[]> =>
    readdir(join(dir, 'overlays', '.backups', 'dev')).catch(() => []);

  it('writes one file per team and project, outside the library listing', async () => {
    const saved = await store.save('dev', 'p1', {
      members: { lead: { settings: { effort: 'max' } } },
    });

    expect(
      await readFile(join(dir, 'overlays', 'dev', 'p1.overlay.yaml'), 'utf8'),
    ).toContain('effort: max');
    expect(await store.get('dev', 'p1')).toMatchObject({
      hash: saved.hash,
      overlay: { members: { lead: { settings: { effort: 'max' } } } },
    });
    expect(await store.get('dev', 'p2')).toBeNull();
    expect(await readdir(dir)).toEqual(['overlays']);
  });

  it('refuses a stale hash with TEAM_OVERLAY_CHANGED and writes nothing', async () => {
    const first = await store.save('dev', 'p1', {
      members: { lead: { extraInstructions: 'one' } },
    });
    await store.save(
      'dev',
      'p1',
      { members: { lead: { extraInstructions: 'two' } } },
      first.hash,
    );

    await expect(
      store.save(
        'dev',
        'p1',
        { members: { lead: { extraInstructions: 'three' } } },
        first.hash,
      ),
    ).rejects.toMatchObject({ errorCode: 'TEAM_OVERLAY_CHANGED' });
    await expect(store.save('dev', 'p1', {}, null)).rejects.toMatchObject({
      errorCode: 'TEAM_OVERLAY_CHANGED',
    });
    expect(
      (await store.get('dev', 'p1'))!.overlay.members!.lead!.extraInstructions,
    ).toBe('two');
  });

  it('lets only one of two saves quoting the same version through', async () => {
    const first = await store.save('dev', 'p1', {});

    const results = await Promise.allSettled([
      store.save(
        'dev',
        'p1',
        { members: { lead: { extraInstructions: 'left' } } },
        first.hash,
      ),
      store.save(
        'dev',
        'p1',
        { members: { lead: { extraInstructions: 'right' } } },
        first.hash,
      ),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { errorCode: 'TEAM_OVERLAY_CHANGED' } });
  });

  it('backs the file up before every replace and delete', async () => {
    const first = await store.save(
      'dev',
      'p1',
      { members: { lead: { extraInstructions: 'v1' } } },
      null,
    );
    expect(await backups()).toEqual([]);

    const second = await store.save(
      'dev',
      'p1',
      { members: { lead: { extraInstructions: 'v2' } } },
      first.hash,
    );
    expect(second.backup).toMatch(/^overlays\/\.backups\/dev\/p1\..+\.yaml$/);
    expect(await readFile(join(dir, second.backup!), 'utf8')).toContain('v1');

    expect(await store.delete('dev', 'p1')).toBe(true);
    const copies = await backups();
    expect(copies).toHaveLength(2);
    const texts = await Promise.all(
      copies.map((name) =>
        readFile(join(dir, 'overlays', '.backups', 'dev', name), 'utf8'),
      ),
    );
    expect(texts.some((text) => text.includes('v2'))).toBe(true);
    expect(await store.get('dev', 'p1')).toBeNull();
  });

  it('lists overlays by team and by project, and removes them with their team or project', async () => {
    await store.save('dev', 'p1', {});
    await store.save('dev', 'p2', {});
    await store.save('ops', 'p1', {});

    expect(await store.listForTeam('dev')).toEqual(['p1', 'p2']);
    expect(await store.listForProject('p1')).toEqual(['dev', 'ops']);

    expect(await store.deleteForProject('p1')).toEqual(['dev', 'ops']);
    expect(await store.listForTeam('dev')).toEqual(['p2']);
    expect(await store.deleteForTeam('dev')).toEqual(['p2']);
    expect(await store.listForTeam('dev')).toEqual([]);
  });

  it('refuses an unreadable file rather than reading it as no overlay', async () => {
    await store.save('dev', 'p1', {});
    await writeFile(
      join(dir, 'overlays', 'dev', 'p1.overlay.yaml'),
      'members: [',
    );

    await expect(store.get('dev', 'p1')).rejects.toMatchObject({
      errorCode: 'TEAM_OVERLAY_UNREADABLE',
    });
  });

  it('restores a file as it was, or removes one that did not exist', async () => {
    const saved = await store.save('dev', 'p1', {
      members: { lead: { extraInstructions: 'keep' } },
    });
    await store.save('dev', 'p1', {
      members: { lead: { extraInstructions: 'new' } },
    });
    await store.restore('dev', 'p1', saved.source);
    expect((await store.get('dev', 'p1'))!.hash).toBe(saved.hash);

    await store.restore('dev', 'p1', null);
    expect(await store.get('dev', 'p1')).toBeNull();
  });
});

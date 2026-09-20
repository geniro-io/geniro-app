import type { EntityManager } from '@mikro-orm/sqlite';
import { NotFoundException } from '@packages/common';
import { describe, expect, it } from 'vitest';

import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import { ChatArtifactsService } from './chat-artifacts.service';

interface Row {
  seq: number;
  payload: string;
  createdAt: Date;
}

/**
 * `Item.payload` is a JSON TEXT column, so the DAO hands back a STRING. Rows
 * are built from `JSON.stringify` here for that reason and not for tidiness:
 * feeding this fold objects is a proxy the test fabricates, and under it a
 * reader that never parses passes every case while dropping every real row.
 */
function row(seq: number, payload: unknown): Row {
  return {
    seq,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    createdAt: new Date(seq * 1000),
  };
}

function artifact(
  artifactId: string,
  version: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    artifactId,
    version,
    title: `${artifactId} v${version}`,
    summary: null,
    key: 'k'.repeat(64),
    ...extra,
  };
}

/** The rows arrive oldest-first, exactly as `ItemDao.artifactRows` orders them. */
function build(rows: Row[], runExists = true): ChatArtifactsService {
  const em = { fork: () => em } as unknown as EntityManager;
  const runDao = {
    getById: () => Promise.resolve(runExists ? { id: 'run' } : null),
  } as unknown as RunDao;
  const itemDao = {
    artifactRows: () => Promise.resolve(rows),
  } as unknown as ItemDao;
  return new ChatArtifactsService(em, runDao, itemDao);
}

describe('ChatArtifactsService', () => {
  it('collapses every revision of one artifact to its newest row', async () => {
    const service = build([
      row(10, artifact('plan', 1)),
      row(20, artifact('plan', 2)),
      row(30, artifact('plan', 3)),
    ]);

    const { artifacts } = await service.read('run');

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      artifactId: 'plan',
      version: 3,
      seq: 30,
    });
  });

  it('lists one entry per artifact, newest first', async () => {
    const service = build([
      row(10, artifact('plan', 1)),
      row(20, artifact('chart', 1)),
      row(30, artifact('plan', 2)),
    ]);

    const { artifacts } = await service.read('run');

    expect(artifacts.map((a) => a.artifactId)).toEqual(['plan', 'chart']);
    expect(artifacts.map((a) => a.seq)).toEqual([30, 20]);
  });

  it('drops a row that cannot address a page, keeping the rest', async () => {
    const service = build([
      row(10, artifact('ok', 1)),
      row(20, { ...artifact('no-key', 1), key: '  ' }),
      row(30, { ...artifact('no-version', 1), version: 0 }),
      row(40, { ...artifact('no-title', 1), title: null }),
      row(50, 'not json at all'),
      row(60, JSON.stringify('a string, validly encoded')),
      row(70, JSON.stringify(null)),
    ]);

    const { artifacts } = await service.read('run');

    expect(artifacts.map((a) => a.artifactId)).toEqual(['ok']);
  });

  it('does NOT let an unreadable later row erase the page it superseded', async () => {
    // The fold keys by artifact and the last write wins — so a malformed row
    // must be dropped BEFORE it reaches the map, or republishing badly would
    // take a working page out of the panel.
    const service = build([
      row(10, artifact('plan', 1)),
      row(20, { ...artifact('plan', 2), key: null }),
    ]);

    const { artifacts } = await service.read('run');

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ artifactId: 'plan', version: 1 });
  });

  it('carries the row summary and the time it was published', async () => {
    const service = build([
      row(10, artifact('plan', 2, { summary: '  three phases  ' })),
    ]);

    const { artifacts } = await service.read('run');

    expect(artifacts[0]?.summary).toBe('three phases');
    expect(artifacts[0]?.at).toBe(new Date(10_000).toISOString());
  });

  it('refuses a run that does not exist', async () => {
    const service = build([], false);

    await expect(service.read('run')).rejects.toBeInstanceOf(NotFoundException);
  });
});

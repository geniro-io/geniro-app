import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tempDir } from '../../agents/__tests__/temp-dir';
import { memoryDb } from '../__tests__/memory-db';
import { MemoryUsageService } from './memory-usage.service';

describe('MemoryUsageService', () => {
  let db: Awaited<ReturnType<typeof memoryDb>>;

  beforeEach(async () => {
    db = await memoryDb();
  });

  afterEach(async () => {
    await db.orm.close();
  });

  it('takes the cutoff once, before counting, and keeps it across launches', async () => {
    const path = join(tempDir('memory-usage-'), 'marker');
    const before = Date.now();

    const first = new MemoryUsageService(db.usageDao, path);
    await first.start();
    const written = readFileSync(path, 'utf8');
    const second = new MemoryUsageService(db.usageDao, path);
    await second.start();

    expect(first.backfillMarker?.cutoff).toBeGreaterThanOrEqual(before);
    expect(first.backfillMarker?.doneVersion).toBeNull();
    expect(second.backfillMarker).toEqual(first.backfillMarker);
    expect(readFileSync(path, 'utf8')).toBe(written);
  });

  it('counts nothing live when the cutoff cannot be recorded', async () => {
    const path = join(tempDir('memory-usage-'), 'missing-dir', 'marker');
    const usage = new MemoryUsageService(db.usageDao, path);
    await usage.start();

    await usage.count(['id-1'], 'reads');

    expect(usage.backfillMarker).toBeNull();
    expect(await db.usageDao.daysOf(['id-1'])).toEqual([]);
  });

  it('keeps counting live but runs no backfill when the marker is unreadable', async () => {
    const path = join(tempDir('memory-usage-'), 'marker');
    writeFileSync(path, 'not json');
    const usage = new MemoryUsageService(db.usageDao, path);
    await usage.start();

    await usage.count(['id-1', 'id-1'], 'reads');

    expect(usage.backfillMarker).toBeNull();
    expect(
      (await db.usageDao.daysOf(['id-1'])).map((day) => day.reads),
    ).toEqual([1]);
  });

  it('keeps counting live but runs no backfill when the marker cannot be read', async () => {
    const path = tempDir('memory-usage-');
    const usage = new MemoryUsageService(db.usageDao, path);
    await usage.start();

    await usage.count(['id-1'], 'reads');

    expect(usage.backfillMarker).toBeNull();
    expect(
      (await db.usageDao.daysOf(['id-1'])).map((day) => day.reads),
    ).toEqual([1]);
  });

  it('records the finished backfill without moving the cutoff', async () => {
    const path = join(tempDir('memory-usage-'), 'marker');
    writeFileSync(path, JSON.stringify({ cutoff: 1234, doneVersion: null }));
    const usage = new MemoryUsageService(db.usageDao, path);
    await usage.start();

    await usage.markBackfilled();
    const reread = new MemoryUsageService(db.usageDao, path);
    await reread.start();

    expect(reread.backfillMarker).toEqual({ cutoff: 1234, doneVersion: 1 });
  });
});

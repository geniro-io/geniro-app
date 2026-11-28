import { describe, expect, it, vi } from 'vitest';

import type { UsageCounterDao } from '../dao/usage-counter.dao';
import type { UsageCounterKey, UsageCounterRow } from '../stats.types';
import { UsageCounterService } from './usage-counter.service';

function key(subject: string): UsageCounterKey {
  return {
    subjectKind: 'tool',
    subject,
    source: '',
    agentKind: 'claude',
    origin: 'direct',
    projectId: '',
  };
}

describe('UsageCounterService', () => {
  it('writes nothing while it counts, and one statement batch per 500 rows on a flush', async () => {
    const add = vi.fn(async (_rows: readonly UsageCounterRow[]) => undefined);
    const service = new UsageCounterService({
      add,
    } as unknown as UsageCounterDao);

    for (let i = 0; i < 1_000; i += 1) {
      service.add(key(`tool-${i % 600}`), { calls: 1 });
    }

    expect(add).not.toHaveBeenCalled();
    expect(service.pendingCount).toBe(600);

    await service.flush();

    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls.map(([rows]) => rows.length)).toEqual([500, 100]);
    expect(
      add.mock.calls
        .flatMap(([rows]) => rows)
        .reduce((sum, row) => sum + row.calls, 0),
    ).toBe(1_000);
    expect(service.pendingCount).toBe(0);
  });

  it('keeps a batch that failed and writes it on the next flush', async () => {
    const add = vi
      .fn<(rows: readonly UsageCounterRow[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockResolvedValue(undefined);
    const service = new UsageCounterService({
      add,
    } as unknown as UsageCounterDao);
    service.add(key('Bash'), { calls: 2, errors: 1 });

    await service.flush();
    expect(service.pendingCount).toBe(1);

    service.add(key('Bash'), { calls: 1 });
    await service.flush();

    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({ subject: 'Bash', calls: 3, errors: 1 }),
    ]);
    expect(service.pendingCount).toBe(0);
  });

  it('flushes what is left at shutdown', async () => {
    const add = vi.fn(async (_rows: readonly UsageCounterRow[]) => undefined);
    const service = new UsageCounterService({
      add,
    } as unknown as UsageCounterDao);
    service.onModuleInit();
    service.add(key('Read'), { calls: 1 });

    await service.onApplicationShutdown();

    expect(add).toHaveBeenCalledTimes(1);
  });
});

import type { EntityManager } from '@mikro-orm/sqlite';

import type { RunDao } from '../../agents/dao/run.dao';
import type { MemoryAutoForgetFilter } from '../dao/memory.dao';
import { MEMORY_DORMANT_SCOPE_DAYS } from '../memory.types';
import { DAY_MS } from './memory-usage-day';

/**
 * What the automatic sweep with a window of `days` takes at `now` — the one
 * filter its run and the summary's figure both read.
 */
export async function autoForgetFilterOf(
  days: number,
  now: Date,
  runs: Pick<RunDao, 'placesWithRunsSince'>,
  em: EntityManager,
): Promise<MemoryAutoForgetFilter> {
  const live = await runs.placesWithRunsSince(
    new Date(now.getTime() - MEMORY_DORMANT_SCOPE_DAYS * DAY_MS),
    em,
  );
  return {
    before: new Date(now.getTime() - days * DAY_MS),
    liveScopes: {
      global: live.any,
      projectIds: live.projectIds,
      teamSlugs: live.teamSlugs,
    },
  };
}

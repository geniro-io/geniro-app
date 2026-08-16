import { describe, expect, it, vi } from 'vitest';

import type { StatsService } from '../services/stats.service';
import type { UsageStatsWire } from '../stats.types';
import { StatsController } from './stats.controller';

describe('StatsController', () => {
  const answer = { totals: { turns: 0 } } as unknown as UsageStatsWire;

  function controller(): {
    route: StatsController;
    usage: ReturnType<typeof vi.fn>;
  } {
    const usage = vi.fn(async () => answer);
    return {
      route: new StatsController({ usage } as unknown as StatsService),
      usage,
    };
  }

  it('passes both bounds through to the service', async () => {
    const { route, usage } = controller();
    const from = '2026-08-01T00:00:00.000Z';
    const to = '2026-08-15T00:00:00.000Z';

    await expect(route.readUsage({ from, to })).resolves.toBe(answer);

    expect(usage).toHaveBeenCalledWith(from, to);
  });

  it('forwards an omitted bound as undefined rather than substituting one', async () => {
    const { route, usage } = controller();

    await route.readUsage({});

    // The service owns what an absent bound MEANS ("as far back as the ledger
    // goes" / "up to now"); a default invented here would put that decision in
    // two places and let them disagree.
    expect(usage).toHaveBeenCalledWith(undefined, undefined);
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  restoreWorkflowVersionSchema,
  workflowVersionsQuerySchema,
} from '../dto/stats.dto';
import type { StatsService } from '../services/stats.service';
import type { WorkflowVersionsService } from '../services/workflow-versions.service';
import type {
  UsageStatsWire,
  WorkflowVersionRestoredWire,
  WorkflowVersionsWire,
} from '../stats.types';
import { StatsController } from './stats.controller';

describe('StatsController', () => {
  const answer = { totals: { turns: 0 } } as unknown as UsageStatsWire;

  function controller(): {
    route: StatsController;
    usage: ReturnType<typeof vi.fn>;
  } {
    const usage = vi.fn(async () => answer);
    return {
      route: new StatsController(
        { usage } as unknown as StatsService,
        {} as WorkflowVersionsService,
      ),
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

  describe('readWorkflowVersions', () => {
    it('hands the slug to the versions service and answers what it read', async () => {
      const versions = {
        slug: 'dev-team',
      } as unknown as WorkflowVersionsWire;
      const read = vi.fn(async () => versions);
      const route = new StatsController(
        {} as StatsService,
        { read } as unknown as WorkflowVersionsService,
      );

      await expect(
        route.readWorkflowVersions({ slug: 'dev-team' }),
      ).resolves.toBe(versions);
      expect(read).toHaveBeenCalledWith('dev-team');
    });

    it.each(['', '../etc', 'has space', '-leading-dash'])(
      'refuses the slug %j before it reaches the service',
      (slug) => {
        expect(workflowVersionsQuerySchema.safeParse({ slug }).success).toBe(
          false,
        );
      },
    );

    it('refuses a request with no slug', () => {
      expect(workflowVersionsQuerySchema.safeParse({}).success).toBe(false);
    });

    it('accepts a library slug', () => {
      expect(
        workflowVersionsQuerySchema.safeParse({ slug: 'dev-team_2' }).success,
      ).toBe(true);
    });
  });

  describe('restoreWorkflowVersion', () => {
    it('hands the slug, version and base hash to the versions service', async () => {
      const answer = { slug: 'dev-team' } as WorkflowVersionRestoredWire;
      const restore = vi.fn(async () => answer);
      const route = new StatsController(
        {} as StatsService,
        { restore } as unknown as WorkflowVersionsService,
      );

      await expect(
        route.restoreWorkflowVersion({
          slug: 'dev-team',
          version: '0123456789abcdef',
          baseHash: 'h1',
        }),
      ).resolves.toBe(answer);
      expect(restore).toHaveBeenCalledWith(
        'dev-team',
        '0123456789abcdef',
        'h1',
      );
    });

    it.each([
      { slug: '../etc', version: '0123456789abcdef' },
      { slug: 'dev-team', version: 'not-a-version' },
      { slug: 'dev-team', version: '0123456789ABCDEF' },
      { slug: 'dev-team' },
    ])('refuses %j before it reaches the service', (body) => {
      expect(restoreWorkflowVersionSchema.safeParse(body).success).toBe(false);
    });
  });
});

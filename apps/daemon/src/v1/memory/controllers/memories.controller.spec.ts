import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import { MemoryImportController } from '../../agents/controllers/memory-import.controller';
import {
  MemoryCreateSchema,
  type MemoryEntry,
  type MemoryForgetBatchList,
  type MemoryForgetBatchResult,
  MemoryListQuerySchema,
  MemoryPatchSchema,
  type MemoryReviewIds,
  type MemoryReviewPage,
  type MemoryReviewSummary,
} from '../memory.types';
import type { MemoryService } from '../services/memory.service';
import type { MemoryReviewService } from '../services/memory-review.service';
import { MemoriesController } from './memories.controller';
import { MemoryConfigController } from './memory-config.controller';

const ENTRY: MemoryEntry = {
  id: 'e1',
  handle: 'm1',
  title: 'Use pnpm',
  body: 'Never npm.',
  type: 'project',
  projectId: null,
  teamSlug: null,
  status: 'active',
  rev: 2,
  source: {
    actor: 'user',
    agentKind: null,
    model: null,
    runId: null,
    importedFrom: null,
  },
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  lastUsedAt: null,
  approvedAt: null,
};

const PAGE: MemoryReviewPage = { rows: [], total: 0, younger: 0, next: null };

const IDS: MemoryReviewIds = { ids: ['e1'], warnedSkipped: 2 };

const SUMMARY: MemoryReviewSummary = {
  active: 3,
  pending: 1,
  read: 1,
  neverRead: 2,
  proposed: 2,
  proposedWithWarning: 1,
  younger: 0,
  kept: 1,
  forgotten: 1,
  minAgeDays: 14,
  countedSince: '2026-11-01',
  counting: false,
  lastBatch: null,
};

const BATCHES: MemoryForgetBatchList = {
  batches: [
    { batchId: 'b1', count: 2, forgottenAt: '2026-11-11T00:00:00.000Z' },
  ],
};

const BATCH_RESULT: MemoryForgetBatchResult = {
  batchId: 'b1',
  forgotten: 1,
  skipped: [],
};

function controllerOver(
  service: Partial<MemoryService>,
  review: Partial<MemoryReviewService> = {},
) {
  return new MemoriesController(
    service as MemoryService,
    review as MemoryReviewService,
  );
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { statusCode?: number; errorCode?: string };
  }
  throw new Error('expected the call to throw');
}

describe('MemoriesController', () => {
  it('is open to paired devices, while the config push and the import stay desktop only', () => {
    const guardsOf = (target: object) =>
      (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[]) ?? [];

    expect(guardsOf(MemoriesController)).not.toContain(DesktopOnlyGuard);
    expect(guardsOf(MemoryConfigController)).toContain(DesktopOnlyGuard);
    expect(guardsOf(MemoryImportController)).toContain(DesktopOnlyGuard);
  });

  it('answers a saved entry, and turns a refusal into its HTTP error', async () => {
    const saved = controllerOver({
      change: async () => ({ kind: 'updated', entry: ENTRY }),
    });
    const stale = controllerOver({
      change: async () => ({ kind: 'stale', current: ENTRY }),
    });
    const duplicate = controllerOver({
      create: async () => ({
        kind: 'near_duplicate',
        candidates: [{ ...ENTRY, excerpt: 'Never npm.' }],
        pending: ['m7'],
        updatable: true,
      }),
    });
    const missing = controllerOver({
      change: async () => ({
        kind: 'refused',
        code: 'NOT_FOUND',
        reason: 'no memory e9',
      }),
    });

    await expect(saved.update('e1', { status: 'active' })).resolves.toBe(ENTRY);
    expect(
      await errorOf(stale.update('e1', { status: 'active' })),
    ).toMatchObject({ errorCode: 'MEMORY_STALE' });
    const conflict = await errorOf(
      duplicate.create({
        title: 'Use pnpm',
        body: 'x',
        type: 'project',
        projectId: null,
      }),
    );
    expect(conflict).toMatchObject({
      errorCode: 'MEMORY_NEAR_DUPLICATE',
      data: { description: 'similar entries exist: m1, m7' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(
      (await errorOf(missing.update('e9', { status: 'forgotten' }))).statusCode,
    ).toBe(404);
  });

  it('answers 404 for an entry that does not exist', async () => {
    const controller = controllerOver({ get: async () => null });

    expect((await errorOf(controller.read('nope'))).statusCode).toBe(404);
  });

  it('takes a PATCH of either a status alone or a whole edit at a rev', () => {
    const edit = {
      rev: 1,
      title: 't',
      body: 'b',
      type: 'project',
      projectId: null,
      teamSlug: null,
    };

    expect(MemoryPatchSchema.safeParse({ status: 'forgotten' }).success).toBe(
      true,
    );
    expect(MemoryPatchSchema.safeParse(edit).success).toBe(true);
    const { teamSlug: _omitted, ...withoutTeam } = edit;
    expect(MemoryPatchSchema.safeParse(withoutTeam).success).toBe(false);
    expect(
      MemoryPatchSchema.safeParse({ ...edit, teamSlug: 'bad slug\n' }).success,
    ).toBe(false);
    expect(
      MemoryPatchSchema.safeParse({ ...edit, status: 'active' }).success,
    ).toBe(false);
    expect(MemoryPatchSchema.safeParse({ title: 't' }).success).toBe(false);
    expect(MemoryPatchSchema.safeParse({ status: 'pending' }).success).toBe(
      false,
    );
  });

  it('takes a cursor whole or not at all, and a project id only with scope: project', () => {
    const ok = (query: object) =>
      MemoryListQuerySchema.safeParse(query).success;

    expect(ok({})).toBe(true);
    expect(ok({ scope: 'project', projectId: 'p1' })).toBe(true);
    expect(ok({ scope: 'project' })).toBe(false);
    expect(ok({ projectId: 'p1' })).toBe(false);
    expect(
      ok({ beforeUpdatedAt: '2026-10-01T00:00:00.000Z', beforeId: 'e1' }),
    ).toBe(true);
    expect(ok({ beforeId: 'e1' })).toBe(false);
  });

  it('takes a team slug only with scope: team', () => {
    const ok = (query: object) =>
      MemoryListQuerySchema.safeParse(query).success;

    expect(ok({ scope: 'team', teamSlug: 'a' })).toBe(true);
    expect(ok({ scope: 'team' })).toBe(false);
    expect(ok({ teamSlug: 'a' })).toBe(false);
    expect(ok({ scope: 'project', projectId: 'p1', teamSlug: 'a' })).toBe(
      false,
    );
  });

  it('files an entry under a project or a team, never both', () => {
    const entry = {
      title: 't',
      body: 'b',
      type: 'project',
      projectId: null,
    };
    const edit = { ...entry, rev: 1 };

    expect(
      MemoryCreateSchema.safeParse({ ...entry, teamSlug: 'a' }).success,
    ).toBe(true);
    expect(MemoryCreateSchema.safeParse(entry).success).toBe(true);
    expect(
      MemoryCreateSchema.safeParse({ ...entry, projectId: 'p1', teamSlug: 'a' })
        .success,
    ).toBe(false);
    expect(
      MemoryPatchSchema.safeParse({ ...edit, teamSlug: 'a' }).success,
    ).toBe(true);
    expect(
      MemoryPatchSchema.safeParse({ ...edit, projectId: 'p1', teamSlug: 'a' })
        .success,
    ).toBe(false);
    expect(
      MemoryPatchSchema.safeParse({ status: 'active', teamSlug: 'a' }).success,
    ).toBe(false);
  });

  it('answers the cleanup reads from the review service, with the query as given', async () => {
    const page = vi.fn(async () => PAGE);
    const ids = vi.fn(async () => IDS);
    const controller = controllerOver(
      {},
      {
        summary: async () => SUMMARY,
        page,
        ids,
        batches: async () => BATCHES,
      },
    );
    const query = { tab: 'kept' as const, limit: 5 };

    expect(await controller.reviewSummary()).toBe(SUMMARY);
    expect(await controller.reviewPage(query)).toBe(PAGE);
    expect(await controller.reviewIds(query)).toBe(IDS);
    expect(await controller.batches()).toBe(BATCHES);
    expect(page).toHaveBeenCalledWith(query);
    expect(ids).toHaveBeenCalledWith(query);
  });

  it('forgets a batch and restores one through the service', async () => {
    const forgetBatch = vi.fn(async () => BATCH_RESULT);
    const restoreBatch = vi.fn(async () => ({ restored: 1 }));
    const controller = controllerOver({ forgetBatch, restoreBatch });

    expect(await controller.forgetBatch({ ids: ['e1', 'e2'] })).toBe(
      BATCH_RESULT,
    );
    expect(await controller.restoreBatch('b1')).toEqual({ restored: 1 });
    expect(forgetBatch).toHaveBeenCalledWith(['e1', 'e2']);
    expect(restoreBatch).toHaveBeenCalledWith('b1');
  });

  it('keeps and unkeeps an entry through the service, answering what it stored', async () => {
    const setKept = vi.fn(async (id: string, kept: boolean) => ({
      id,
      keptAt: kept ? '2026-11-11T00:00:00.000Z' : null,
    }));
    const controller = controllerOver({ setKept });

    expect(await controller.keep('e1')).toEqual({
      id: 'e1',
      keptAt: '2026-11-11T00:00:00.000Z',
    });
    expect(await controller.unkeep('e1')).toEqual({ id: 'e1', keptAt: null });
    expect(setKept.mock.calls).toEqual([
      ['e1', true],
      ['e1', false],
    ]);
  });

  it('answers 404 MEMORY_NOT_FOUND when keeping or unkeeping an entry that does not exist', async () => {
    const controller = controllerOver({ setKept: async () => null });

    expect(await errorOf(controller.keep('nope'))).toMatchObject({
      statusCode: 404,
      errorCode: 'MEMORY_NOT_FOUND',
    });
    expect(await errorOf(controller.unkeep('nope'))).toMatchObject({
      statusCode: 404,
      errorCode: 'MEMORY_NOT_FOUND',
    });
  });

  it('leaves every cleanup route open to paired devices, as the rest of the controller is', () => {
    const cleanupRoutes = [
      'reviewSummary',
      'reviewPage',
      'reviewIds',
      'forgetBatch',
      'batches',
      'restoreBatch',
      'keep',
      'unkeep',
    ] as const;

    for (const route of cleanupRoutes) {
      expect(
        Reflect.getMetadata(
          GUARDS_METADATA,
          MemoriesController.prototype[route],
        ),
      ).toBeUndefined();
    }
    expect(
      (Reflect.getMetadata(GUARDS_METADATA, MemoriesController) as unknown[]) ??
        [],
    ).not.toContain(DesktopOnlyGuard);
  });
});

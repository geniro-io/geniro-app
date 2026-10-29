import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import { MemoryImportController } from '../../agents/controllers/memory-import.controller';
import {
  type MemoryEntry,
  MemoryListQuerySchema,
  MemoryPatchSchema,
} from '../memory.types';
import type { MemoryService } from '../services/memory.service';
import { MemoriesController } from './memories.controller';
import { MemoryConfigController } from './memory-config.controller';

const ENTRY: MemoryEntry = {
  id: 'e1',
  handle: 'm1',
  title: 'Use pnpm',
  body: 'Never npm.',
  type: 'project',
  projectId: null,
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

function controllerOver(service: Partial<MemoryService>) {
  return new MemoriesController(service as MemoryService);
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
    };

    expect(MemoryPatchSchema.safeParse({ status: 'forgotten' }).success).toBe(
      true,
    );
    expect(MemoryPatchSchema.safeParse(edit).success).toBe(true);
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
});

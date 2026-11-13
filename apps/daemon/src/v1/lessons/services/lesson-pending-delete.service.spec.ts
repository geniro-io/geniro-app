import type { EntityManager } from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { ChatService } from '../../agents/services/chat.service';
import { ExtractLessonsOnDeleteRegistry } from '../../agents/services/extract-lessons-on-delete.registry';
import type { Run } from '../../runs/entity/run.entity';
import type { TeamExecutorService } from '../../teams/services/team-executor.service';
import { LESSON_PENDING_DELETE_MAX_MS } from '../lessons.types';
import { LessonPendingDeleteService } from './lesson-pending-delete.service';
import type { LessonReflectionService } from './lesson-reflection.service';

function runOf(overrides: Partial<Run> = {}): Run {
  return {
    id: 'src',
    title: 'Migrate the cache',
    status: 'completed',
    agentKind: 'claude',
    configDir: null,
    teamId: null,
    projectId: null,
    analysisSourceRunId: null,
    analysisTeamSlug: null,
    editsTeamSlug: null,
    editsProjectId: null,
    reflectedThroughSeq: null,
    pendingDeleteAt: null,
    archivedAt: null,
    ...overrides,
  } as unknown as Run;
}

function build(
  options: {
    runs?: Run[];
    pending?: Run[];
    startFails?: Error;
  } = {},
) {
  const runs = new Map((options.runs ?? [runOf()]).map((run) => [run.id, run]));
  const em = { fork: () => em } as unknown as EntityManager;
  const runDao = {
    getById: vi.fn((runId: string) => Promise.resolve(runs.get(runId) ?? null)),
    updateById: vi.fn(() => Promise.resolve()),
    listPendingDeletes: vi.fn(() => Promise.resolve(options.pending ?? [])),
  };
  const chats = {
    archive: vi.fn(() => Promise.resolve({})),
    delete: vi.fn((_runId: string) => Promise.resolve({ deleted: true })),
  };
  const teamRuns = {
    deleteRun: vi.fn((_runId: string) => Promise.resolve({ deleted: true })),
  };
  const reflections = {
    start: vi.fn(() =>
      options.startFails === undefined
        ? Promise.resolve({
            reflectionRunId: 'refl-1',
            segmentId: 'seg-1',
            fromSeq: -1,
            toSeq: 2,
          })
        : Promise.reject(options.startFails),
    ),
  };
  const bus = new AgentEventBus();
  const registry = new ExtractLessonsOnDeleteRegistry();
  const service = new LessonPendingDeleteService(
    em,
    runDao as unknown as RunDao,
    chats as unknown as ChatService,
    teamRuns as unknown as TeamExecutorService,
    reflections as unknown as LessonReflectionService,
    bus,
    registry,
  );
  return {
    service,
    em,
    runs,
    runDao,
    chats,
    teamRuns,
    reflections,
    bus,
    registry,
  };
}

/** Lets the settle chain's awaited reads and deletes finish, without moving the clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('LessonPendingDeleteService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('extractThenDelete', () => {
    it('archives the thread, marks it pending delete and starts its reflection as a delete', async () => {
      const h = build();

      await expect(h.service.extractThenDelete('src')).resolves.toEqual({
        deleted: true,
      });

      expect(h.chats.archive).toHaveBeenCalledWith('src');
      expect(h.runDao.updateById).toHaveBeenCalledWith(
        'src',
        { pendingDeleteAt: expect.any(Date) },
        h.em,
      );
      expect(h.reflections.start).toHaveBeenCalledWith('src', {}, 'delete');
      expect(h.chats.delete).not.toHaveBeenCalled();
    });

    it('does not archive a thread that is already archived', async () => {
      const h = build({ runs: [runOf({ archivedAt: new Date() })] });

      await h.service.extractThenDelete('src');

      expect(h.chats.archive).not.toHaveBeenCalled();
      expect(h.reflections.start).toHaveBeenCalledTimes(1);
    });

    it('answers null, and starts nothing, for a thread that has nothing to reflect on', async () => {
      const h = build({ runs: [runOf({ editsProjectId: 'p1' })] });

      await expect(h.service.extractThenDelete('src')).resolves.toBeNull();

      expect(h.chats.archive).not.toHaveBeenCalled();
      expect(h.runDao.updateById).not.toHaveBeenCalled();
      expect(h.reflections.start).not.toHaveBeenCalled();
    });

    it('answers null when its reflection cannot start, so the route deletes as usual', async () => {
      const h = build({ startFails: new Error('no reflection') });

      await expect(h.service.extractThenDelete('src')).resolves.toBeNull();

      expect(h.chats.delete).not.toHaveBeenCalled();
      expect(h.teamRuns.deleteRun).not.toHaveBeenCalled();
    });
  });

  describe('the delete once the reflection settles', () => {
    it('deletes a chat when its reflection reaches a terminal status', async () => {
      const h = build();
      h.service.onModuleInit();
      await h.service.extractThenDelete('src');

      h.bus.publishRunStatus({ runId: 'refl-1', status: 'completed' });
      await settle();

      expect(h.chats.delete).toHaveBeenCalledTimes(1);
      expect(h.chats.delete).toHaveBeenCalledWith('src');
      expect(h.teamRuns.deleteRun).not.toHaveBeenCalled();
    });

    it('deletes a team run through teamRuns.deleteRun', async () => {
      const h = build({ runs: [runOf({ teamId: 'team-1' })] });
      h.service.onModuleInit();
      await h.service.extractThenDelete('src');

      h.bus.publishRunStatus({ runId: 'refl-1', status: 'failed' });
      await settle();

      expect(h.teamRuns.deleteRun).toHaveBeenCalledWith('src');
      expect(h.chats.delete).not.toHaveBeenCalled();
    });

    it('does not delete on a reflection status that is not terminal yet', async () => {
      const h = build();
      h.service.onModuleInit();
      await h.service.extractThenDelete('src');

      h.bus.publishRunStatus({ runId: 'refl-1', status: 'running' });
      await settle();

      expect(h.chats.delete).not.toHaveBeenCalled();
    });

    it('deletes at LESSON_PENDING_DELETE_MAX_MS when the reflection never settles, once', async () => {
      const h = build();
      h.service.onModuleInit();
      await h.service.extractThenDelete('src');

      await vi.advanceTimersByTimeAsync(LESSON_PENDING_DELETE_MAX_MS - 1);
      await settle();
      expect(h.chats.delete).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(h.chats.delete).toHaveBeenCalledTimes(1);

      h.bus.publishRunStatus({ runId: 'refl-1', status: 'completed' });
      await settle();
      await vi.advanceTimersByTimeAsync(LESSON_PENDING_DELETE_MAX_MS);
      await settle();
      expect(h.chats.delete).toHaveBeenCalledTimes(1);
    });

    it('a settle before the cap deletes once, and the cap then does nothing', async () => {
      const h = build();
      h.service.onModuleInit();
      await h.service.extractThenDelete('src');

      h.bus.publishRunStatus({ runId: 'refl-1', status: 'completed' });
      await settle();
      expect(h.chats.delete).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(LESSON_PENDING_DELETE_MAX_MS);
      await settle();
      expect(h.chats.delete).toHaveBeenCalledTimes(1);
    });

    it('deletes nothing when the thread is gone by the time its reflection settles', async () => {
      const h = build();
      h.service.onModuleInit();
      await h.service.extractThenDelete('src');
      h.runs.delete('src');

      h.bus.publishRunStatus({ runId: 'refl-1', status: 'completed' });
      await settle();

      expect(h.chats.delete).not.toHaveBeenCalled();
    });
  });

  describe('start-up and module lifetime', () => {
    it('deletes every run left pending delete when the daemon starts, chats and team runs alike', async () => {
      const h = build({
        pending: [
          runOf({ id: 'chat-a', teamId: null, pendingDeleteAt: new Date() }),
          runOf({
            id: 'team-b',
            teamId: 'team-1',
            pendingDeleteAt: new Date(),
          }),
        ],
      });

      await h.service.onApplicationBootstrap();

      expect(h.runDao.listPendingDeletes).toHaveBeenCalledTimes(1);
      expect(h.chats.delete).toHaveBeenCalledWith('chat-a');
      expect(h.teamRuns.deleteRun).toHaveBeenCalledWith('team-b');
    });

    it('takes the extract-first handler into the registry on init and gives it back on destroy', async () => {
      const h = build();
      const use = vi.spyOn(h.registry, 'use');

      h.service.onModuleInit();
      expect(use).toHaveBeenCalledTimes(1);
      await expect(h.registry.extract('src')).resolves.toEqual({
        deleted: true,
      });

      h.service.onModuleDestroy();
      await expect(h.registry.extract('src')).resolves.toBeNull();
    });

    it('stops deleting on settle once destroyed, and drops its cap', async () => {
      const h = build();
      h.service.onModuleInit();
      await h.service.extractThenDelete('src');

      h.service.onModuleDestroy();
      h.bus.publishRunStatus({ runId: 'refl-1', status: 'completed' });
      await settle();
      await vi.advanceTimersByTimeAsync(LESSON_PENDING_DELETE_MAX_MS);
      await settle();

      expect(h.chats.delete).not.toHaveBeenCalled();
    });
  });
});

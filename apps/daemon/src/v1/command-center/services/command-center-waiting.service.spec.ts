import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NO_CALL_INDEX } from '../../agents/__tests__/no-call-index';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ItemSeqAllocator } from '../../agents/services/item-seq.allocator';
import { RunNoticeWriter } from '../../agents/services/run-notice.writer';
import { itemToWire } from '../../agents/utils/item-wire';
import type { KnowledgeRevisionDao } from '../../knowledge/dao/knowledge-revision.dao';
import type { KnowledgeEventBus } from '../../knowledge/services/knowledge-events.bus';
import type { LessonProposalDao } from '../../lessons/dao/lesson-proposal.dao';
import type { LessonsEventBus } from '../../lessons/services/lessons-events.bus';
import type { MemoryDao } from '../../memory/dao/memory.dao';
import type { MemoryEventBus } from '../../memory/services/memory-events.bus';
import { commandCenterDb } from '../__tests__/command-center-db';
import type { CommandCenterService } from './command-center.service';
import type { CommandCenterEventBus } from './command-center-events.bus';
import { CommandCenterWaitingService } from './command-center-waiting.service';
import { ManagerAnnouncementsService } from './manager-announcements.service';

const MANAGER = 'manager-1';

type Db = Awaited<ReturnType<typeof commandCenterDb>>;
type Pending = { id: string; handle: number; body: string };
type Titled = { id: string; title: string };

describe('CommandCenterWaitingService', () => {
  let db: Db;
  let managerRunId: string | null;
  let memories: Pending[];
  let lessons: Titled[];
  let revisions: Titled[];
  let pendingEntries: ReturnType<typeof vi.fn<() => Promise<Pending[]>>>;
  let lessonList: ReturnType<
    typeof vi.fn<(filter: { statuses: string[] }) => Promise<Titled[]>>
  >;
  let pendingHeads: ReturnType<typeof vi.fn<() => Promise<Titled[]>>>;
  let memoryChanges: Subject<unknown>;
  let lessonChanges: Subject<unknown>;
  let knowledgeChanges: Subject<unknown>;
  let boardChanges: Subject<{ reason: string }>;
  let makeService: (notices?: RunNoticeWriter) => CommandCenterWaitingService;
  let service: CommandCenterWaitingService;

  beforeEach(async () => {
    db = await commandCenterDb();
    await db.seedRun(MANAGER);
    managerRunId = MANAGER;
    memories = [];
    lessons = [];
    revisions = [];
    memoryChanges = new Subject();
    lessonChanges = new Subject();
    knowledgeChanges = new Subject();
    boardChanges = new Subject();
    pendingEntries = vi.fn(() => Promise.resolve(memories));
    lessonList = vi.fn((_filter: { statuses: string[] }) =>
      Promise.resolve(lessons),
    );
    pendingHeads = vi.fn(() => Promise.resolve(revisions));
    const itemDao = new ItemDao(db.em);
    const realNotices = () =>
      new RunNoticeWriter(
        db.em,
        new RunDao(db.em),
        itemDao,
        new AgentEventBus(),
        NO_CALL_INDEX,
        new ItemSeqAllocator(db.em, itemDao),
      );
    makeService = (notices = realNotices()) =>
      new CommandCenterWaitingService(
        db.em,
        new ManagerAnnouncementsService(db.em, itemDao),
        notices,
        {
          managerRunId: vi.fn(() => Promise.resolve(managerRunId)),
        } as unknown as CommandCenterService,
        { pendingEntries } as unknown as MemoryDao,
        { list: lessonList } as unknown as LessonProposalDao,
        { pendingHeads } as unknown as KnowledgeRevisionDao,
        { allChanges: () => memoryChanges } as unknown as MemoryEventBus,
        { allChanges: () => lessonChanges } as unknown as LessonsEventBus,
        { allChanges: () => knowledgeChanges } as unknown as KnowledgeEventBus,
        { allChanges: () => boardChanges } as unknown as CommandCenterEventBus,
      );
    service = makeService();
  });

  afterEach(async () => {
    service.onModuleDestroy();
    await db.orm.close(true);
  });

  async function managerRows(): Promise<
    { message: string; waitingItems: { kind: string; items: Titled[] } }[]
  > {
    const rows = await new ItemDao(db.em).rowsOfKinds(MANAGER, ['system']);
    return rows.map((row) => itemToWire(row).payload) as never;
  }

  function lessonsOf(count: number): Titled[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `lesson-${index}`,
      title: `Lesson ${index}`,
    }));
  }

  it('writes one row with one item for a new pending memory entry', async () => {
    memories = [
      { id: 'mem-1', handle: 12, body: '  Prefer   pnpm\nsecond line' },
    ];

    await service.review('memory');

    expect(await managerRows()).toEqual([
      expect.objectContaining({
        message: 'memory waits for your review: m12 Prefer pnpm',
        waitingItems: {
          kind: 'memory',
          items: [{ id: 'mem-1', title: 'm12 Prefer pnpm' }],
        },
      }),
    ]);
  });

  it('caps a memory title at 120 characters', async () => {
    memories = [{ id: 'mem-1', handle: 1, body: 'y'.repeat(500) }];

    await service.review('memory');

    const [row] = await managerRows();
    expect(row?.waitingItems.items[0]?.title).toHaveLength(120);
  });

  it('announces six waiting lessons at once as one summary row', async () => {
    lessons = lessonsOf(6);

    await service.review('lesson');

    const rows = await managerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      message: '6 lesson items wait for your review',
    });
    expect(rows[0]?.waitingItems.items).toEqual(lessonsOf(6));
  });

  it('announces five waiting lessons as five rows', async () => {
    lessons = lessonsOf(5);

    await service.review('lesson');

    const rows = await managerRows();
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.waitingItems.items.length === 1)).toBe(true);
  });

  it('writes nothing again for an announced id, also from a fresh service instance', async () => {
    lessons = lessonsOf(2);
    await service.review('lesson');
    await service.review('lesson');
    expect(await managerRows()).toHaveLength(2);

    const restarted = makeService();
    lessons = [...lessonsOf(2), { id: 'lesson-new', title: 'New' }];
    await restarted.review('lesson');
    restarted.onModuleDestroy();

    const rows = await managerRows();
    expect(rows).toHaveLength(3);
    expect(rows.at(-1)?.waitingItems.items).toEqual([
      { id: 'lesson-new', title: 'New' },
    ]);
  });

  it('writes nothing when there is no manager run', async () => {
    managerRunId = null;
    memories = [{ id: 'mem-1', handle: 1, body: 'x' }];

    await service.review('memory');

    expect(await managerRows()).toEqual([]);
  });

  it('announces a pending knowledge revision', async () => {
    revisions = [{ id: 'rev-1', title: 'Deploy guide' }];

    await service.review('knowledge');

    expect(await managerRows()).toEqual([
      expect.objectContaining({
        message: 'knowledge waits for your review: Deploy guide',
        waitingItems: {
          kind: 'knowledge',
          items: [{ id: 'rev-1', title: 'Deploy guide' }],
        },
      }),
    ]);
  });

  it('reviews only the kind whose change event arrived', async () => {
    memories = [{ id: 'mem-1', handle: 1, body: 'x' }];
    lessons = lessonsOf(1);
    revisions = [{ id: 'rev-1', title: 'Doc' }];
    service.onModuleInit();

    knowledgeChanges.next({});
    await vi.waitFor(async () => {
      expect(await managerRows()).toHaveLength(1);
    });

    expect(pendingHeads).toHaveBeenCalledTimes(1);
    expect(pendingEntries).not.toHaveBeenCalled();
    expect(lessonList).not.toHaveBeenCalled();
  });

  it('reviews memory, lessons and knowledge at bootstrap', async () => {
    service.onApplicationBootstrap();

    await vi.waitFor(() => {
      expect(pendingEntries).toHaveBeenCalledTimes(1);
      expect(lessonList).toHaveBeenCalledTimes(1);
      expect(pendingHeads).toHaveBeenCalledTimes(1);
    });
  });

  it('reviews all three kinds on a roster change and none on a status change', async () => {
    service.onModuleInit();

    boardChanges.next({ reason: 'status' });
    await service.review('memory');
    expect(lessonList).not.toHaveBeenCalled();
    expect(pendingHeads).not.toHaveBeenCalled();
    expect(pendingEntries).toHaveBeenCalledTimes(1);

    boardChanges.next({ reason: 'roster' });
    await vi.waitFor(() => {
      expect(pendingEntries).toHaveBeenCalledTimes(2);
      expect(lessonList).toHaveBeenCalledTimes(1);
      expect(pendingHeads).toHaveBeenCalledTimes(1);
    });
  });

  it('asks for lessons by exactly the waiting statuses', async () => {
    await service.review('lesson');

    expect(lessonList).toHaveBeenCalledWith(
      { statuses: ['proposed', 'check_failed'] },
      expect.anything(),
    );
  });

  it('writes the items on the next review when a row was not written', async () => {
    const real = new RunNoticeWriter(
      db.em,
      new RunDao(db.em),
      new ItemDao(db.em),
      new AgentEventBus(),
      NO_CALL_INDEX,
      new ItemSeqAllocator(db.em, new ItemDao(db.em)),
    );
    let failNext = true;
    const info = vi.fn(async (...args: Parameters<RunNoticeWriter['info']>) => {
      if (failNext) {
        failNext = false;
        return false;
      }
      return real.info(...args);
    });
    const flaky = makeService({ info } as unknown as RunNoticeWriter);
    lessons = lessonsOf(2);

    await flaky.review('lesson');
    expect((await managerRows()).map((row) => row.waitingItems.items)).toEqual([
      [lessonsOf(2)[1]],
    ]);
    await flaky.review('lesson');
    await flaky.review('lesson');
    flaky.onModuleDestroy();

    expect((await managerRows()).map((row) => row.waitingItems.items)).toEqual([
      [lessonsOf(2)[1]],
      [lessonsOf(2)[0]],
    ]);
  });

  it('writes the whole summary again when its row was not written', async () => {
    const real = new RunNoticeWriter(
      db.em,
      new RunDao(db.em),
      new ItemDao(db.em),
      new AgentEventBus(),
      NO_CALL_INDEX,
      new ItemSeqAllocator(db.em, new ItemDao(db.em)),
    );
    let failNext = true;
    const info = vi.fn(async (...args: Parameters<RunNoticeWriter['info']>) => {
      if (failNext) {
        failNext = false;
        return false;
      }
      return real.info(...args);
    });
    const flaky = makeService({ info } as unknown as RunNoticeWriter);
    lessons = lessonsOf(6);

    await flaky.review('lesson');
    await flaky.review('lesson');
    flaky.onModuleDestroy();

    const rows = await managerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.waitingItems.items).toEqual(lessonsOf(6));
  });
});

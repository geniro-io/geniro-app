import { NotFoundException } from '@packages/common';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NO_CALL_INDEX } from '../../agents/__tests__/no-call-index';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ItemSeqAllocator } from '../../agents/services/item-seq.allocator';
import { RunNoticeWriter } from '../../agents/services/run-notice.writer';
import { itemToWire } from '../../agents/utils/item-wire';
import type { MemoryEventBus } from '../../memory/services/memory-events.bus';
import type { MemoryFindingsService } from '../../memory/services/memory-findings.service';
import type { ShareService } from '../../shares/services/share.service';
import type { ShareEventBus } from '../../shares/services/share-events.bus';
import { commandCenterDb } from '../__tests__/command-center-db';
import { CommandCenterDoneDismissalDao } from '../dao/command-center-done-dismissal.dao';
import { CommandCenterNoticeDao } from '../dao/command-center-notice.dao';
import type { CommandCenterService } from './command-center.service';
import type { CommandCenterEventBus } from './command-center-events.bus';
import { CommandCenterNoticesService } from './command-center-notices.service';

const MANAGER = 'manager-1';

type Db = Awaited<ReturnType<typeof commandCenterDb>>;
type ShareRow = { id: string; destinationId: string; status: string };

describe('CommandCenterNoticesService', () => {
  let db: Db;
  let managerRunId: string | null;
  let shares: ShareRow[];
  let findingIds: string[];
  let shareChanges: Subject<unknown>;
  let memoryChanges: Subject<unknown>;
  let boardChanges: Subject<{ reason: string }>;
  let deleted: Subject<string>;
  let publishChanged: ReturnType<typeof vi.fn>;
  let services: CommandCenterNoticesService[];
  let make: (notices?: RunNoticeWriter) => CommandCenterNoticesService;
  let service: CommandCenterNoticesService;

  beforeEach(async () => {
    db = await commandCenterDb();
    await db.seedRun(MANAGER);
    managerRunId = MANAGER;
    shares = [];
    findingIds = [];
    shareChanges = new Subject();
    memoryChanges = new Subject();
    boardChanges = new Subject();
    deleted = new Subject();
    publishChanged = vi.fn();
    services = [];
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
    make = (notices = realNotices()) => {
      const made = new CommandCenterNoticesService(
        notices,
        {
          managerRunId: vi.fn(() => Promise.resolve(managerRunId)),
        } as unknown as CommandCenterService,
        new CommandCenterNoticeDao(db.em),
        new CommandCenterDoneDismissalDao(db.em),
        itemDao,
        {
          list: vi.fn(() => Promise.resolve(shares)),
        } as unknown as ShareService,
        {
          open: vi.fn(() => Promise.resolve(findingIds.map((id) => ({ id })))),
        } as unknown as MemoryFindingsService,
        { allChanges: () => shareChanges } as unknown as ShareEventBus,
        { allChanges: () => memoryChanges } as unknown as MemoryEventBus,
        {
          allChanges: () => boardChanges,
          publishChanged,
        } as unknown as CommandCenterEventBus,
        { allDeleted: () => deleted } as unknown as AgentEventBus,
      );
      made.onModuleInit();
      services.push(made);
      return made;
    };
    service = make();
  });

  afterEach(async () => {
    for (const made of services) {
      made.onModuleDestroy();
    }
    await db.orm.close(true);
  });

  async function noticeRows(): Promise<
    {
      message: string;
      woke: boolean;
      settingsNotice: { noticeId: string; kind: string; key: string };
    }[]
  > {
    const rows = await new ItemDao(db.em).rowsOfKinds(MANAGER, ['system']);
    return rows
      .map((row) => itemToWire(row).payload as Record<string, unknown>)
      .filter((payload) => payload.settingsNotice !== undefined) as never;
  }

  const listed = async (
    made: CommandCenterNoticesService = service,
  ): Promise<
    Awaited<ReturnType<CommandCenterNoticesService['list']>>['notices']
  > => (await made.list()).notices;

  const update = (...items: string[]) => ({
    readings: [{ kind: 'app-update' as const, items }],
  });

  it('writes one chat row for a new Geniro update, named by its notice', async () => {
    await service.report(update('1.4.0'));

    const rows = await noticeRows();
    const [notice] = await listed();
    expect(rows).toEqual([
      expect.objectContaining({
        message: 'A Geniro update is available',
        woke: false,
        settingsNotice: {
          noticeId: notice!.id,
          kind: 'app-update',
          key: 'app-update',
        },
      }),
    ]);
    expect(notice).toMatchObject({
      kind: 'app-update',
      items: ['1.4.0'],
      resolvedAt: null,
      dismissedAt: null,
    });
    expect(publishChanged).toHaveBeenCalledWith([MANAGER], 'notices');
  });

  it('writes no second row for a reading it already announced, from either of two windows at once', async () => {
    await Promise.all([
      service.report(update('1.4.0')),
      service.report(update('1.4.0')),
    ]);
    await service.report(update('1.4.0'));

    expect(await noticeRows()).toHaveLength(1);
  });

  it('writes no second row after a restart', async () => {
    await service.report(update('1.4.0'));
    const restarted = make();

    await restarted.report(update('1.4.0'));

    expect(await noticeRows()).toHaveLength(1);
  });

  it('keeps one row while an undismissed update moves to a newer version', async () => {
    await service.report(update('1.4.0'));
    await service.report(update('1.5.0'));

    expect(await noticeRows()).toHaveLength(1);
    expect((await listed())[0]!.items).toEqual(['1.4.0', '1.5.0']);
  });

  it('resolves a notice once its reason goes and opens a new row when it comes back', async () => {
    await service.report({
      readings: [{ kind: 'agent-sign-in', items: ['claude:'] }],
    });
    await service.report({ readings: [{ kind: 'agent-sign-in', items: [] }] });
    await service.report({
      readings: [{ kind: 'agent-sign-in', items: ['claude:'] }],
    });

    const notices = await listed();
    expect(notices).toHaveLength(2);
    expect(notices.map((entry) => entry.key)).toEqual([
      'agent-sign-in:claude:',
      'agent-sign-in:claude:',
    ]);
    expect(notices[0]!.resolvedAt).not.toBeNull();
    expect(notices[1]!.resolvedAt).toBeNull();
    expect(await noticeRows()).toHaveLength(2);
  });

  it('leaves the kinds a report did not read alone', async () => {
    await service.report(update('1.4.0'));
    await service.report({
      readings: [{ kind: 'agent-updates', items: [] }],
    });

    expect((await listed())[0]!.resolvedAt).toBeNull();
  });

  it('keeps a dismissal across a restart and writes nothing for the items it showed', async () => {
    await service.report(update('1.4.0'));
    const [notice] = await listed();

    const dismissed = await service.dismiss(notice!.id);
    await make().report(update('1.4.0'));

    expect(dismissed.dismissedAt).not.toBeNull();
    expect((await listed(make()))[0]!.dismissedAt).not.toBeNull();
    expect(await noticeRows()).toHaveLength(1);
  });

  it('opens a new row when a dismissed update is followed by a newer version', async () => {
    await service.report(update('1.4.0'));
    await service.dismiss((await listed())[0]!.id);

    await service.report(update('1.5.0'));

    const notices = await listed();
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({ items: ['1.4.0'] });
    expect(notices[0]!.resolvedAt).not.toBeNull();
    expect(notices[1]).toMatchObject({
      items: ['1.5.0'],
      resolvedAt: null,
      dismissedAt: null,
    });
    expect(await noticeRows()).toHaveLength(2);
  });

  it('answers NOTICE_NOT_FOUND for a notice it never had', async () => {
    const error: unknown = await service
      .dismiss('nope')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect(JSON.stringify(error)).toContain('NOTICE_NOT_FOUND');
  });

  it('announces shares waiting on a sign-in once per place, on their change', async () => {
    shares = [
      { id: 's1', destinationId: 'gcloud', status: 'awaiting-sign-in' },
      { id: 's2', destinationId: 'gcloud', status: 'awaiting-sign-in' },
      { id: 's3', destinationId: 'aws', status: 'uploaded' },
    ];

    await service.review('share-sign-in');

    expect((await noticeRows()).map((row) => row.settingsNotice.key)).toEqual([
      'share-sign-in:gcloud',
    ]);
    expect((await listed())[0]!.items).toEqual(['s1', 's2']);

    shares = [];
    await service.review('share-sign-in');
    expect((await listed())[0]!.resolvedAt).not.toBeNull();
  });

  it('announces memory conflicts as one notice of their finding ids', async () => {
    findingIds = ['f1', 'f2'];

    await service.review('memory-conflicts');

    expect(await listed()).toEqual([
      expect.objectContaining({
        kind: 'memory-conflicts',
        key: 'memory-conflicts',
        items: ['f1', 'f2'],
      }),
    ]);
  });

  it('writes nothing while there is no manager chat', async () => {
    managerRunId = null;

    await service.report(update('1.4.0'));

    expect(await listed()).toEqual([]);
  });

  it('opens no notice whose chat row could not be written, so the next reading opens it again', async () => {
    const failing = make({
      info: vi.fn(() => Promise.resolve(false)),
    } as unknown as RunNoticeWriter);

    await failing.report(update('1.4.0'));
    expect(await listed(failing)).toEqual([]);

    await service.report(update('1.4.0'));
    expect(await noticeRows()).toHaveLength(1);
  });

  it('gives each CLI update and each signed-out account a row of its own', async () => {
    await service.report({
      readings: [{ kind: 'agent-updates', items: ['claude@2.0.0'] }],
    });
    await service.report({
      readings: [
        { kind: 'agent-updates', items: ['claude@2.0.0', 'codex@0.9.0'] },
        { kind: 'agent-sign-in', items: ['claude:', 'claude:/cfg/work'] },
      ],
    });

    expect((await noticeRows()).map((row) => row.settingsNotice.key)).toEqual([
      'agent-updates:claude',
      'agent-updates:codex',
      'agent-sign-in:claude:',
      'agent-sign-in:claude:/cfg/work',
    ]);
  });

  it('reviews shares and memory conflicts on their own change announces and on a roster change', async () => {
    shares = [
      { id: 's1', destinationId: 'gcloud', status: 'awaiting-sign-in' },
    ];
    shareChanges.next({});
    await vi.waitFor(async () => {
      expect(await listed()).toHaveLength(1);
    });

    findingIds = ['f1'];
    memoryChanges.next({});
    await vi.waitFor(async () => {
      expect(await listed()).toHaveLength(2);
    });

    const review = vi.spyOn(service, 'review');
    boardChanges.next({ reason: 'status' });
    expect(review).not.toHaveBeenCalled();

    boardChanges.next({ reason: 'roster' });
    expect(review.mock.calls).toEqual([
      ['share-sign-in'],
      ['memory-conflicts'],
    ]);
  });

  it('reviews shares and memory conflicts once at bootstrap', async () => {
    findingIds = ['f1'];

    service.onApplicationBootstrap();

    await vi.waitFor(async () => {
      expect(await listed()).toEqual([
        expect.objectContaining({ kind: 'memory-conflicts' }),
      ]);
    });
  });

  it('drops its notices with the manager run', async () => {
    await service.report(update('1.4.0'));

    deleted.next(MANAGER);
    await vi.waitFor(async () => {
      expect(await new CommandCenterNoticeDao(db.em).list(MANAGER)).toEqual([]);
    });
  });

  it('keeps a report made while there is no manager chat and writes its rows once one joins the roster', async () => {
    managerRunId = null;
    await service.report(update('1.4.0'));
    expect(await noticeRows()).toEqual([]);

    managerRunId = MANAGER;
    boardChanges.next({ reason: 'roster' });

    await vi.waitFor(async () => {
      expect((await noticeRows()).map((row) => row.settingsNotice.key)).toEqual(
        ['app-update'],
      );
    });
    expect((await listed())[0]!.items).toEqual(['1.4.0']);
  });

  describe('Done cards', () => {
    const done = (runId: string) => ({
      runId,
      title: runId,
      handle: 't1',
      summary: null,
      pullRequest: null,
    });

    async function doneRowSeq(...runIds: string[]): Promise<number> {
      const writer = new RunNoticeWriter(
        db.em,
        new RunDao(db.em),
        new ItemDao(db.em),
        new AgentEventBus(),
        NO_CALL_INDEX,
        new ItemSeqAllocator(db.em, new ItemDao(db.em)),
      );
      await writer.info(MANAGER, 'done', { threadDone: runIds.map(done) });
      const rows = await new ItemDao(db.em).rowsOfKinds(MANAGER, ['system']);
      return Math.max(...rows.map((row) => row.seq));
    }

    it('records a dismissed Done card for every device and announces it', async () => {
      const seq = await doneRowSeq('thread-a', 'thread-b');

      const answer = await service.dismissDone('thread-b', seq);

      expect(answer.doneDismissals).toEqual([
        { runId: 'thread-b', throughSeq: seq },
      ]);
      expect((await make().list()).doneDismissals).toEqual([
        { runId: 'thread-b', throughSeq: seq },
      ]);
      expect(publishChanged).toHaveBeenCalledWith([MANAGER], 'notices');
    });

    it('moves a thread forward to its newer finish and never back to an older one', async () => {
      const first = await doneRowSeq('thread-a');
      const second = await doneRowSeq('thread-a');

      await service.dismissDone('thread-a', second);
      publishChanged.mockClear();
      await service.dismissDone('thread-a', first);

      expect((await service.list()).doneDismissals).toEqual([
        { runId: 'thread-a', throughSeq: second },
      ]);
      expect(publishChanged).not.toHaveBeenCalled();
    });

    it('refuses a seq that is not a Done row of that thread', async () => {
      const seq = await doneRowSeq('thread-a');

      await expect(service.dismissDone('thread-b', seq)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        service.dismissDone('thread-a', seq + 50),
      ).rejects.toBeInstanceOf(NotFoundException);
      managerRunId = null;
      await expect(service.dismissDone('thread-a', seq)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      managerRunId = MANAGER;
      expect((await service.list()).doneDismissals).toEqual([]);
    });

    it('drops its dismissals with the manager run', async () => {
      await service.dismissDone('thread-a', await doneRowSeq('thread-a'));

      deleted.next(MANAGER);
      await vi.waitFor(async () => {
        expect(
          await new CommandCenterDoneDismissalDao(db.em).list(MANAGER),
        ).toEqual([]);
      });
    });
  });
});

import { randomUUID } from 'node:crypto';

import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { NotFoundException } from '@packages/common';
import type { Subscription } from 'rxjs';

import type { SettingsNoticeKind } from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { RunNoticeWriter } from '../../agents/services/run-notice.writer';
import { itemToWire } from '../../agents/utils/item-wire';
import { asRecord } from '../../agents/utils/json-util';
import { KeyedChain } from '../../agents/utils/keyed-chain';
import { MemoryEventBus } from '../../memory/services/memory-events.bus';
import { MemoryFindingsService } from '../../memory/services/memory-findings.service';
import { ShareService } from '../../shares/services/share.service';
import { ShareEventBus } from '../../shares/services/share-events.bus';
import type {
  SettingsNotice,
  SettingsNoticeReadings,
  SettingsNotices,
} from '../command-center.types';
import { CommandCenterDoneDismissalDao } from '../dao/command-center-done-dismissal.dao';
import { CommandCenterNoticeDao } from '../dao/command-center-notice.dao';
import type { CommandCenterNotice } from '../entity/command-center-notice.entity';
import {
  type NoticeReading,
  type OpenNotice,
  planNotices,
  readingsByKey,
} from '../utils/notice-plan';
import { CommandCenterService } from './command-center.service';
import { CommandCenterEventBus } from './command-center-events.bus';

const NOTICE_MESSAGES: Record<SettingsNoticeKind, string> = {
  'app-update': 'A Geniro update is available',
  'agent-updates': 'Agent updates are available',
  'agent-sign-in': 'An agent account needs sign-in',
  'share-sign-in': 'Shared links wait for a storage sign-in',
  'memory-conflicts': 'Memory conflicts wait for your decision',
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function itemsOf(row: CommandCenterNotice): string[] {
  try {
    const parsed: unknown = JSON.parse(row.items);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

export function noticeToWire(row: CommandCenterNotice): SettingsNotice {
  return {
    id: row.id,
    kind: row.kind,
    key: row.key,
    items: itemsOf(row),
    label: row.label,
    openedAt: row.openedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
  };
}

/** Whether the manager chat row `payload` announces `runId` as done. */
function announcesDone(payload: unknown, runId: string): boolean {
  const done = asRecord(payload)?.threadDone;
  return (
    Array.isArray(done) &&
    done.some((entry) => asRecord(entry)?.runId === runId)
  );
}

/**
 * The manager chat's Settings notices: each one a row written into the chat
 * when its first reading lands, then resolved, widened or dismissed there.
 * Shares waiting on a sign-in and memory conflicts are read here; the Geniro
 * update and the agent CLIs live in Electron main, so the desktop window
 * reports them, and the last report is kept so a manager started later gets
 * its rows. Every change of one manager runs in order. It also keeps how far
 * the user dismissed each thread's Done cards.
 */
@Injectable()
export class CommandCenterNoticesService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(CommandCenterNoticesService.name);
  private readonly chain = new KeyedChain();
  private readonly subscriptions: Subscription[] = [];
  private lastReported: SettingsNoticeReadings | null = null;

  constructor(
    private readonly notices: RunNoticeWriter,
    private readonly board: CommandCenterService,
    private readonly dao: CommandCenterNoticeDao,
    private readonly doneDismissals: CommandCenterDoneDismissalDao,
    private readonly items: ItemDao,
    private readonly shares: ShareService,
    private readonly findings: MemoryFindingsService,
    private readonly shareEvents: ShareEventBus,
    private readonly memoryEvents: MemoryEventBus,
    private readonly boardEvents: CommandCenterEventBus,
    private readonly agents: AgentEventBus,
  ) {}

  onModuleInit(): void {
    this.subscriptions.push(
      this.shareEvents.allChanges().subscribe(() => {
        void this.review('share-sign-in');
      }),
      this.memoryEvents.allChanges().subscribe(() => {
        void this.review('memory-conflicts');
      }),
      this.boardEvents.allChanges().subscribe(({ reason }) => {
        if (reason === 'roster') {
          this.reviewAll();
        }
      }),
      this.agents.allDeleted().subscribe((runId) => {
        void Promise.all([
          this.dao.deleteOf(runId),
          this.doneDismissals.deleteOf(runId),
        ]).catch((error: unknown) => {
          this.logger.warn(
            `notices of ${runId} not dropped with it: ${messageOf(error)}`,
          );
        });
      }),
    );
  }

  onApplicationBootstrap(): void {
    this.reviewAll();
  }

  onModuleDestroy(): void {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
  }

  async list(): Promise<SettingsNotices> {
    const managerRunId = await this.board.managerRunId();
    if (managerRunId === null) {
      return { notices: [], doneDismissals: [] };
    }
    const [notices, dismissals] = await Promise.all([
      this.dao.list(managerRunId),
      this.doneDismissals.list(managerRunId),
    ]);
    return {
      notices: notices.map(noticeToWire),
      doneDismissals: dismissals.map(({ runId, throughSeq }) => ({
        runId,
        throughSeq,
      })),
    };
  }

  async report(reported: SettingsNoticeReadings): Promise<void> {
    this.lastReported = reported;
    const managerRunId = await this.board.managerRunId();
    if (managerRunId === null) {
      return;
    }
    const { readings } = reported;
    await this.apply(
      managerRunId,
      new Set(readings.map((reading) => reading.kind)),
      () =>
        Promise.resolve(
          readings.flatMap((reading) =>
            readingsByKey(reading.kind, reading.items),
          ),
        ),
      new Set(
        readings.flatMap((reading) =>
          readingsByKey(reading.kind, reading.unsettled).map(({ key }) => key),
        ),
      ),
    );
  }

  async dismiss(noticeId: string): Promise<SettingsNotice> {
    const row = await this.dao.read(noticeId);
    if (row === null) {
      throw new NotFoundException('NOTICE_NOT_FOUND', `no notice ${noticeId}`);
    }
    if (await this.dao.dismiss(noticeId, new Date())) {
      this.boardEvents.publishChanged([row.managerRunId], 'notices');
    }
    const after = await this.dao.read(noticeId);
    return noticeToWire(after ?? row);
  }

  /**
   * The user put a thread's Done card away, on any device: every Done row of
   * that thread up to `seq` draws nothing, and its next finish is a new card.
   */
  async dismissDone(runId: string, seq: number): Promise<SettingsNotices> {
    const managerRunId = await this.board.managerRunId();
    const row =
      managerRunId === null
        ? null
        : await this.items.rowAtSeq(managerRunId, seq);
    if (
      managerRunId === null ||
      row === null ||
      !announcesDone(itemToWire(row).payload, runId)
    ) {
      throw new NotFoundException(
        'DONE_ROW_NOT_FOUND',
        `no Done row of ${runId} at seq ${seq}`,
      );
    }
    const changed = await this.chain.run(managerRunId, () =>
      this.doneDismissals.dismiss(managerRunId, runId, seq, new Date()),
    );
    if (changed) {
      this.boardEvents.publishChanged([managerRunId], 'notices');
    }
    return this.list();
  }

  async review(kind: 'share-sign-in' | 'memory-conflicts'): Promise<void> {
    try {
      const managerRunId = await this.board.managerRunId();
      if (managerRunId !== null) {
        await this.apply(managerRunId, new Set([kind]), () =>
          this.readObserved(kind),
        );
      }
    } catch (error: unknown) {
      this.logger.warn(`${kind} notices not reviewed: ${messageOf(error)}`);
    }
  }

  private reviewAll(): void {
    void this.review('share-sign-in');
    void this.review('memory-conflicts');
    if (this.lastReported !== null) {
      void this.report(this.lastReported).catch((error: unknown) => {
        this.logger.warn(`reported notices not reviewed: ${messageOf(error)}`);
      });
    }
  }

  private async readObserved(
    kind: 'share-sign-in' | 'memory-conflicts',
  ): Promise<NoticeReading[]> {
    if (kind === 'memory-conflicts') {
      const ids = (await this.findings.open()).map((finding) => finding.id);
      return [{ kind, key: kind, items: ids, label: null }];
    }
    const byPlace = new Map<string, NoticeReading>();
    for (const share of await this.shares.list()) {
      if (share.status !== 'awaiting-sign-in') {
        continue;
      }
      const key = `share-sign-in:${share.destinationId}`;
      byPlace.set(key, {
        kind,
        key,
        items: [...(byPlace.get(key)?.items ?? []), share.id],
        label: share.signIn?.label ?? share.destinationName,
      });
    }
    return [...byPlace.values()];
  }

  private apply(
    managerRunId: string,
    kinds: ReadonlySet<SettingsNoticeKind>,
    read: () => Promise<NoticeReading[]>,
    unsettled: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    return this.chain.run(managerRunId, async () => {
      const readings = await read();
      const open: OpenNotice[] = (await this.dao.listOpen(managerRunId)).map(
        (row) => ({
          id: row.id,
          kind: row.kind,
          key: row.key,
          items: itemsOf(row),
          label: row.label,
          dismissed: row.dismissedAt !== null,
        }),
      );
      const steps = planNotices(open, kinds, readings, unsettled);
      if (steps.length === 0) {
        return;
      }
      const at = new Date();
      for (const step of steps) {
        if (step.op === 'resolve') {
          await this.dao.resolve(step.id, at);
        } else if (step.op === 'update') {
          await this.dao.update(step.id, step.items, step.label);
        } else {
          await this.announce(managerRunId, step.reading, at);
        }
      }
      this.boardEvents.publishChanged([managerRunId], 'notices');
    });
  }

  private async announce(
    managerRunId: string,
    reading: NoticeReading,
    at: Date,
  ): Promise<void> {
    const noticeId = randomUUID();
    const written = await this.notices.info(
      managerRunId,
      NOTICE_MESSAGES[reading.kind],
      {
        settingsNotice: { noticeId, kind: reading.kind, key: reading.key },
      },
    );
    if (written) {
      await this.dao.open({
        id: noticeId,
        managerRunId,
        kind: reading.kind,
        key: reading.key,
        items: reading.items,
        label: reading.label,
        openedAt: at,
      });
    }
  }
}

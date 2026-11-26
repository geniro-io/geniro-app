import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';

import {
  WAITING_ITEM_KINDS,
  WAITING_ITEMS_SUMMARY_OVER,
  type WaitingItemKind,
  type WaitingItemsRow,
} from '../../agents/chat.types';
import { RunNoticeWriter } from '../../agents/services/run-notice.writer';
import { KeyedChain } from '../../agents/utils/keyed-chain';
import { KnowledgeRevisionDao } from '../../knowledge/dao/knowledge-revision.dao';
import { KnowledgeEventBus } from '../../knowledge/services/knowledge-events.bus';
import { LessonProposalDao } from '../../lessons/dao/lesson-proposal.dao';
import { LESSON_WAITING_STATUSES } from '../../lessons/lessons.types';
import { LessonsEventBus } from '../../lessons/services/lessons-events.bus';
import { MemoryDao } from '../../memory/dao/memory.dao';
import { MemoryEventBus } from '../../memory/services/memory-events.bus';
import { CommandCenterService } from './command-center.service';
import { CommandCenterEventBus } from './command-center-events.bus';
import { ManagerAnnouncementsService } from './manager-announcements.service';

type WaitingItem = WaitingItemsRow['items'][number];

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Tells the manager chat, once per item, what waits for the user's review in
 * shared memory, lessons and knowledge. The rows already in the chat are the
 * truth about what was told; nothing is retired, edited or woken.
 */
@Injectable()
export class CommandCenterWaitingService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(CommandCenterWaitingService.name);
  private readonly chain = new KeyedChain();
  private readonly subscriptions: Subscription[] = [];

  constructor(
    private readonly em: EntityManager,
    private readonly announcements: ManagerAnnouncementsService,
    private readonly notices: RunNoticeWriter,
    private readonly board: CommandCenterService,
    private readonly memories: MemoryDao,
    private readonly lessons: LessonProposalDao,
    private readonly revisions: KnowledgeRevisionDao,
    private readonly memoryEvents: MemoryEventBus,
    private readonly lessonEvents: LessonsEventBus,
    private readonly knowledgeEvents: KnowledgeEventBus,
    private readonly boardEvents: CommandCenterEventBus,
  ) {}

  onModuleInit(): void {
    this.subscriptions.push(
      this.memoryEvents.allChanges().subscribe(() => {
        void this.review('memory');
      }),
      this.lessonEvents.allChanges().subscribe(() => {
        void this.review('lesson');
      }),
      this.knowledgeEvents.allChanges().subscribe(() => {
        void this.review('knowledge');
      }),
      this.boardEvents.allChanges().subscribe(({ reason }) => {
        if (reason === 'roster') {
          this.reviewAll();
        }
      }),
    );
  }

  onApplicationBootstrap(): void {
    this.reviewAll();
  }

  private reviewAll(): void {
    for (const kind of WAITING_ITEM_KINDS) {
      void this.review(kind);
    }
  }

  onModuleDestroy(): void {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
  }

  review(kind: WaitingItemKind): Promise<void> {
    return this.chain
      .run(kind, () => this.reviewNow(kind))
      .catch((error: unknown) => {
        this.logger.warn(`${kind} items not reviewed: ${messageOf(error)}`);
      });
  }

  private async reviewNow(kind: WaitingItemKind): Promise<void> {
    const managerRunId = await this.board.managerRunId();
    if (managerRunId === null) {
      return;
    }
    const announced = (await this.announcements.of(managerRunId)).itemIds;
    const fresh = (await this.waiting(kind)).filter(
      (item) => !announced.has(item.id),
    );
    if (fresh.length === 0) {
      return;
    }
    for (const item of fresh) {
      announced.add(item.id);
    }
    if (fresh.length > WAITING_ITEMS_SUMMARY_OVER) {
      const written = await this.notices.info(
        managerRunId,
        `${fresh.length} ${kind} items wait for your review`,
        { waitingItems: { kind, items: fresh } },
      );
      if (!written) {
        for (const item of fresh) {
          announced.delete(item.id);
        }
      }
      return;
    }
    for (const item of fresh) {
      const written = await this.notices.info(
        managerRunId,
        `${kind} waits for your review: ${item.title}`,
        { waitingItems: { kind, items: [item] } },
      );
      if (!written) {
        announced.delete(item.id);
      }
    }
  }

  private async waiting(kind: WaitingItemKind): Promise<WaitingItem[]> {
    const em = this.em.fork();
    if (kind === 'memory') {
      return (await this.memories.pendingEntries(em)).map((entry) => ({
        id: entry.id,
        title: clean(entry.title),
      }));
    }
    if (kind === 'lesson') {
      return (
        await this.lessons.list({ statuses: [...LESSON_WAITING_STATUSES] }, em)
      ).map((proposal) => ({ id: proposal.id, title: clean(proposal.title) }));
    }
    return (await this.revisions.pendingHeads(em)).map((revision) => ({
      id: revision.id,
      title: clean(revision.title),
    }));
  }
}

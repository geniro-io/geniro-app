import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';

import { RunDao } from '../dao/run.dao';
import {
  type AttentionMemory,
  NO_ATTENTION_MEMORY,
  readAttention,
} from '../utils/run-attention';
import { AgentEventBus } from './agent-events.bus';

/**
 * Keeps the UNREAD mark on the daemon, where every device can read it.
 *
 * The mark used to be computed by each renderer from the status broadcasts it
 * happened to receive, and held in that window's memory: so a thread opened on
 * the phone stayed bold on the desktop, a thread that finished while the phone
 * was locked was never bold there at all, and a reload forgot every mark.
 * REPORTED as wanting "unread or not" synced between mobile and PC.
 *
 * A SUBSCRIBER to the status broadcast rather than a call from the settle
 * paths, for the reason `PullRequestCaptureService` is one: the bus is where a
 * chat and a workflow run converge, so one subscription covers both and no
 * turn path has to remember to stamp anything. Its half is `Run.attentionAt`;
 * the other half, `Run.seenAt`, is written by `ChatService.markSeen` when a
 * device opens the thread. Both are announced on the same `run_status`
 * broadcast, so every client re-derives the mark from the same two moments.
 */
@Injectable()
export class RunAttentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunAttentionService.name);
  /** What this process last heard per run — see {@link readAttention}. */
  private readonly memory = new Map<string, AttentionMemory>();
  private statusSubscription?: Subscription;
  private deletedSubscription?: Subscription;

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly bus: AgentEventBus,
  ) {}

  onModuleInit(): void {
    this.statusSubscription = this.bus.allStatuses().subscribe((event) => {
      const { earns, after } = readAttention(
        event,
        this.memory.get(event.runId) ?? NO_ATTENTION_MEMORY,
      );
      this.memory.set(event.runId, after);
      if (earns) {
        void this.stamp(event.runId);
      }
    });
    this.deletedSubscription = this.bus
      .allDeleted()
      .subscribe((runId) => this.memory.delete(runId));
  }

  onModuleDestroy(): void {
    this.statusSubscription?.unsubscribe();
    this.deletedSubscription?.unsubscribe();
  }

  /**
   * Write the moment and tell every client. Never throws: a subscriber that
   * rejects takes the RxJS stream down with it, and a lost mark costs one bold
   * row where a dead stream costs every mark after it.
   */
  private async stamp(runId: string): Promise<void> {
    try {
      const attentionAt = new Date();
      await this.runDao.updateWithoutActivity(
        runId,
        { attentionAt },
        this.em.fork(),
      );
      this.bus.publishRunStatus({
        runId,
        status: null,
        attentionAt: attentionAt.toISOString(),
      });
    } catch (err) {
      this.logger.warn(
        `could not mark run ${runId} unread: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

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
  HOST_THREAD_QUESTION_CARD,
  type RunWire,
  type ThreadQuestionCardInput,
} from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { ApprovalRegistry } from '../../agents/services/approval-registry';
import { ChatService } from '../../agents/services/chat.service';
import { HostWakeBus } from '../../agents/services/host-wake.bus';
import { itemToWire } from '../../agents/utils/item-wire';
import { KeyedChain } from '../../agents/utils/keyed-chain';
import { UNTITLED_THREAD } from '../../agents/utils/thread-message-text';
import {
  ANSWERABILITY_KINDS,
  unansweredRequests,
} from '../../agents/utils/unanswerable';
import { TaskDao } from '../../tasks/dao/task.dao';
import { TeamExecutorService } from '../../teams/services/team-executor.service';
import type { CommandCenterColumn } from '../command-center.types';
import { CommandCenterRosterDao } from '../dao/command-center-roster.dao';
import { boardColumnOf } from '../utils/board-column';
import { managerWake } from '../utils/manager-wake';
import { CommandCenterService } from './command-center.service';
import { CommandCenterEventBus } from './command-center-events.bus';

const OUTCOME_SUMMARY_MAX = 300;

/** A thread's open request, relayed as a card in the manager chat. */
interface Relay {
  managerRunId: string;
  relayId: string;
  threadRunId: string;
  threadRequestId: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function capped(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function donePrompt(handle: string, run: RunWire): string {
  const title = clean(run.title ?? UNTITLED_THREAD);
  const pullRequest = run.pullRequests.find((pr) => pr.opened);
  const summary = run.outcome?.summary ?? null;
  return [
    `[command center] Thread ${handle} "${title}" is done`,
    pullRequest === undefined ? '' : ` (PR #${pullRequest.number})`,
    '.',
    summary === null || clean(summary) === ''
      ? ''
      : ` Its outcome: ${capped(clean(summary), OUTCOME_SUMMARY_MAX)}`,
    ' Tell the user in one or two lines what it finished.',
  ].join('');
}

/**
 * What the manager hears about the threads on its roster, and nothing else:
 * one wake when a thread reaches done, and each open question or approval of a
 * thread relayed into its chat as a card whose answer goes to that thread —
 * with no wake, since the user answers it. A status change alone is never
 * told. Driven by the board's own change stream, so it reads a thread only
 * when its card moved.
 *
 * A thread's first reading only records its column: a boot never wakes the
 * manager about threads that were done before it.
 */
@Injectable()
export class CommandCenterNotifyService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(CommandCenterNotifyService.name);
  private readonly columns = new Map<string, CommandCenterColumn>();
  private readonly relays = new Map<string, Relay>();
  private readonly chain = new KeyedChain();
  private subscription: Subscription | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly chats: ChatService,
    private readonly executor: TeamExecutorService,
    private readonly approvals: ApprovalRegistry,
    private readonly itemDao: ItemDao,
    private readonly taskDao: TaskDao,
    private readonly wakes: HostWakeBus,
    private readonly roster: CommandCenterRosterDao,
    private readonly board: CommandCenterService,
    private readonly events: CommandCenterEventBus,
  ) {}

  onModuleInit(): void {
    this.subscription = this.events.allChanges().subscribe(({ runIds }) => {
      for (const runId of runIds) {
        void this.review(runId);
      }
    });
  }

  onApplicationBootstrap(): void {
    void this.boot();
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  /** Read one thread again and tell the manager what it must hear. */
  review(runId: string): Promise<void> {
    return this.chain
      .run(runId, () => this.reviewNow(runId))
      .catch((error: unknown) => {
        this.logger.warn(`thread ${runId} not reviewed: ${messageOf(error)}`);
      });
  }

  /**
   * Close what a restart left of earlier relays — the registry entries behind
   * them are gone — then read every thread on the roster afresh.
   */
  private async boot(): Promise<void> {
    try {
      const managerRunId = await this.board.managerRunId();
      if (managerRunId === null) {
        return;
      }
      const em = this.em.fork();
      const rows = await this.itemDao.rowsOfKinds(
        managerRunId,
        ANSWERABILITY_KINDS,
        undefined,
        em,
      );
      for (const { payload } of unansweredRequests(rows)) {
        if (payload.toolName === HOST_THREAD_QUESTION_CARD) {
          await this.chats.retireOwnedCard(
            managerRunId,
            payload.id,
            HOST_THREAD_QUESTION_CARD,
          );
        }
      }
      const onRoster = (await this.roster.listOf(managerRunId, em)).filter(
        (row) => row.leftAt === null,
      );
      await Promise.all(onRoster.map((row) => this.review(row.threadRunId)));
    } catch (error) {
      this.logger.warn(`command center boot review failed: ${messageOf(error)}`);
    }
  }

  private async reviewNow(runId: string): Promise<void> {
    const managerRunId = await this.board.managerRunId();
    if (managerRunId === null || runId === managerRunId) {
      return;
    }
    const em = this.em.fork();
    const entry = (await this.roster.listOf(managerRunId, em)).find(
      (row) => row.threadRunId === runId && row.leftAt === null,
    );
    const run = entry === undefined ? null : await this.runOf(runId);
    if (entry === undefined || run === null) {
      this.columns.delete(runId);
      await this.closeRelays(runId, managerRunId, new Set());
      return;
    }
    await this.relayRequests(managerRunId, entry.handle, run);
    const [task] = await this.taskDao.listByRunIds([runId], em);
    const column = boardColumnOf(run, task?.status ?? null);
    const previous = this.columns.get(runId);
    this.columns.set(runId, column);
    if (previous !== undefined && previous !== 'done' && column === 'done') {
      this.wakes.publish(
        managerWake(
          managerRunId,
          `done:${runId}`,
          donePrompt(entry.handle, run),
          `${entry.handle} is done`,
        ),
      );
    }
  }

  private async runOf(runId: string): Promise<RunWire | null> {
    const [chat] = await this.chats.listChats('all', { runIds: [runId] });
    if (chat !== undefined) {
      return chat;
    }
    const [team] = await this.executor.listRuns('all', { runIds: [runId] });
    return team ?? null;
  }

  /** Relay each open request of the thread not relayed yet, and close the relays of requests gone. */
  private async relayRequests(
    managerRunId: string,
    handle: string,
    run: RunWire,
  ): Promise<void> {
    const open = this.approvals.listByRun(run.id);
    await this.closeRelays(
      run.id,
      managerRunId,
      new Set(open.map((entry) => entry.requestId)),
    );
    const fresh = open.filter(
      (entry) => !this.relays.has(relayKey(run.id, entry.requestId)),
    );
    if (fresh.length === 0) {
      return;
    }
    const rows = await this.itemDao.rowsByPayloadId(
      run.id,
      ['approval_request'],
      fresh.map((entry) => entry.requestId),
      undefined,
      this.em.fork(),
    );
    const payloads = new Map(
      rows.map((row) => {
        const payload = (itemToWire(row).payload ?? {}) as Record<
          string,
          unknown
        >;
        return [payload.id, payload] as const;
      }),
    );
    for (const entry of fresh) {
      const payload = payloads.get(entry.requestId) ?? {};
      const relay: Relay = {
        managerRunId,
        relayId: this.approvals.mintCardId(HOST_THREAD_QUESTION_CARD),
        threadRunId: run.id,
        threadRequestId: entry.requestId,
      };
      const input: ThreadQuestionCardInput = {
        threadRunId: run.id,
        threadRequestId: entry.requestId,
        handle,
        threadTitle: run.title ?? UNTITLED_THREAD,
        toolName: entry.toolName,
        input: entry.input,
        ...(payload.questions === undefined
          ? {}
          : { questions: payload.questions }),
        ...(payload.options === undefined ? {} : { options: payload.options }),
      };
      this.relays.set(relayKey(run.id, entry.requestId), relay);
      try {
        await this.chats.raiseOwnedCard(
          managerRunId,
          relay.relayId,
          { toolName: HOST_THREAD_QUESTION_CARD, input },
          (allow, answer, optionId) => {
            this.answer(relay, allow, answer, optionId);
          },
        );
      } catch (error) {
        this.relays.delete(relayKey(run.id, entry.requestId));
        this.logger.warn(
          `request ${entry.requestId} of thread ${run.id} not relayed: ${messageOf(error)}`,
        );
      }
    }
  }

  /** The user answered the relayed card: the answer goes to the thread's own request. */
  private answer(
    relay: Relay,
    allow: boolean,
    answer?: string,
    optionId?: string,
  ): void {
    this.relays.delete(relayKey(relay.threadRunId, relay.threadRequestId));
    const delivered = this.approvals.resolve(
      relay.threadRunId,
      relay.threadRequestId,
      allow,
      answer,
      optionId,
    );
    void this.chats.recordOwnedCardVerdict(
      relay.managerRunId,
      relay.relayId,
      allow,
      {
        ...(answer === undefined ? {} : { answer }),
        outcome: delivered ? 'delivered' : 'not-delivered',
      },
    );
  }

  /**
   * Close the relays of `threadRunId` whose request is no longer open — it was
   * answered in the thread, or its turn ended — and any raised for another
   * manager.
   */
  private async closeRelays(
    threadRunId: string,
    managerRunId: string,
    stillOpen: ReadonlySet<string>,
  ): Promise<void> {
    for (const [key, relay] of this.relays) {
      if (
        relay.threadRunId !== threadRunId ||
        (stillOpen.has(relay.threadRequestId) &&
          relay.managerRunId === managerRunId)
      ) {
        continue;
      }
      this.relays.delete(key);
      try {
        await this.chats.retireOwnedCard(
          relay.managerRunId,
          relay.relayId,
          HOST_THREAD_QUESTION_CARD,
        );
      } catch (error) {
        this.logger.warn(
          `relay ${relay.relayId} not closed: ${messageOf(error)}`,
        );
      }
    }
  }
}

function relayKey(threadRunId: string, requestId: string): string {
  return `${threadRunId}\n${requestId}`;
}

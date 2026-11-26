import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { BaseException } from '@packages/common';

import {
  type ArchiveThreadsAnswer,
  type ArchiveThreadsInput,
  type NoteThreadAnswer,
  type NoteThreadInput,
  type ReadCommandCenterAnswer,
  SINGLE_AGENT_NODE,
  type TellThreadsAnswer,
  type TellThreadsInput,
} from '../../agents/chat.types';
import { RunDao } from '../../agents/dao/run.dao';
import { ChatService } from '../../agents/services/chat.service';
import { CommandCenterOpsBroker } from '../../agents/services/command-center-ops.broker';
import { UNTITLED_THREAD } from '../../agents/utils/thread-message-text';
import { isMessageableThread } from '../../agents/utils/thread-runs';
import { ThreadDeliveryService } from '../../teams/services/thread-delivery.service';
import {
  type CommandCenterCard,
  REPLY_CREDIT_MS,
} from '../command-center.types';
import { CommandCenterRosterDao } from '../dao/command-center-roster.dao';
import { type NameableThread, resolveTarget } from '../utils/resolve-target';
import { CommandCenterService } from './command-center.service';
import {
  CommandCenterChatService,
  type RosterThread,
} from './command-center-chat.service';
import { CommandCenterEventBus } from './command-center-events.bus';
import { CommandCenterStartsService } from './command-center-starts.service';

type Unresolved = TellThreadsAnswer['unresolved'][number];

function candidatesOf(threads: readonly NameableThread[]) {
  return threads.map((thread) => ({
    handle: thread.handle,
    title: thread.title,
  }));
}

function graphThreadOf(card: CommandCenterCard) {
  return {
    handle: card.handle,
    runId: card.run.id,
    title: card.run.title ?? UNTITLED_THREAD,
    project: card.run.project?.name ?? null,
    column: card.column,
    status: card.run.status,
    awaiting: card.run.awaiting ?? null,
    awaitingReply: card.contact.awaitingReply,
    pullRequest: card.run.pullRequests.find((pr) => pr.opened)?.number ?? null,
    taskCard:
      card.task === null
        ? null
        : {
            identifier: card.task.identifier,
            title: card.task.title,
            status: card.task.status,
          },
    lastActivityAt: card.run.lastActivityAt,
    note: card.note,
  };
}

function nameableOf(threads: readonly RosterThread[]): NameableThread[] {
  return threads.map(({ entry, run, done }) => ({
    handle: entry.handle,
    runId: entry.threadRunId,
    title: run?.title ?? UNTITLED_THREAD,
    done,
  }));
}

/**
 * What the manager's tools do, installed on `CommandCenterOpsBroker` for the
 * MCP host to reach. Every target is resolved against the manager's roster
 * first, and `tell_threads` sends nothing at all while any target is
 * unresolved — a message half-delivered to the wrong set is worse than none.
 */
@Injectable()
export class CommandCenterOpsService implements OnModuleInit, OnModuleDestroy {
  private uninstall: (() => void) | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly broker: CommandCenterOpsBroker,
    private readonly delivery: ThreadDeliveryService,
    private readonly roster: CommandCenterRosterDao,
    private readonly managers: CommandCenterChatService,
    private readonly starts: CommandCenterStartsService,
    private readonly events: CommandCenterEventBus,
    private readonly chats: ChatService,
    private readonly board: CommandCenterService,
  ) {}

  onModuleInit(): void {
    this.uninstall = this.broker.install({
      tell: (managerRunId, input) => this.tell(managerRunId, input),
      note: (managerRunId, input) => this.note(managerRunId, input),
      start: (managerRunId, input) => this.starts.start(managerRunId, input),
      archive: (managerRunId, input) => this.archive(managerRunId, input),
      read: (managerRunId) => this.read(managerRunId),
    });
  }

  onModuleDestroy(): void {
    this.uninstall?.();
  }

  async tell(
    managerRunId: string,
    input: TellThreadsInput,
  ): Promise<TellThreadsAnswer> {
    await this.assertManager(managerRunId);
    const roster = await this.nameable(managerRunId);
    const resolved: { to: string; thread: NameableThread }[] = [];
    const unresolved: Unresolved[] = [];
    for (const to of input.to) {
      const found = await this.resolve(to, roster);
      if ('thread' in found) {
        resolved.push({ to, thread: found.thread });
      } else {
        unresolved.push({ to, ...found });
      }
    }
    if (unresolved.length > 0) {
      return { sent: [], unresolved };
    }
    const replyCreditUntil = input.expect_reply
      ? new Date(Date.now() + REPLY_CREDIT_MS)
      : null;
    const marksBefore = new Map(
      (await this.roster.listOf(managerRunId)).map((row) => [
        row.threadRunId,
        { announcedFinish: row.announcedFinish, watch: row.watch },
      ]),
    );
    const sent: TellThreadsAnswer['sent'] = [];
    const seen = new Set<string>();
    for (const { to, thread } of resolved) {
      if (seen.has(thread.runId)) {
        continue;
      }
      seen.add(thread.runId);
      await this.roster.clearAnnounced(managerRunId, [thread.runId]);
      if (input.watch !== undefined) {
        await this.roster.setWatch(managerRunId, [thread.runId], input.watch);
      }
      const row = await this.sendOne(
        managerRunId,
        to,
        thread,
        input.message,
        replyCreditUntil,
      );
      sent.push(row);
      const before = marksBefore.get(thread.runId);
      if (row.outcome === 'refused' && before !== undefined) {
        await this.roster.replaceMarks(
          managerRunId,
          thread.runId,
          { announcedFinish: null, watch: input.watch ?? before.watch },
          before,
        );
      }
    }
    const reachedAny = sent.some((row) => row.outcome !== 'refused');
    return {
      sent,
      unresolved: [],
      ...(input.watch === undefined || !reachedAny
        ? {}
        : { watch: input.watch }),
    };
  }

  private async sendOne(
    managerRunId: string,
    to: string,
    thread: NameableThread,
    text: string,
    replyCreditUntil: Date | null,
  ): Promise<TellThreadsAnswer['sent'][number]> {
    try {
      const answer = await this.delivery.send({
        from: {
          target: 'chat',
          runId: managerRunId,
          memberId: SINGLE_AGENT_NODE,
          conversationId: null,
          caller: SINGLE_AGENT_NODE,
        },
        toRunId: thread.runId,
        text,
        wake: true,
        replyCreditUntil,
      });
      return {
        to,
        runId: thread.runId,
        title: answer.title,
        outcome: answer.outcome,
        code: answer.reason ?? null,
      };
    } catch (error) {
      return {
        to,
        runId: thread.runId,
        title: thread.title,
        outcome: 'refused',
        code:
          error instanceof BaseException ? error.errorCode : 'DELIVERY_FAILED',
      };
    }
  }

  async note(
    managerRunId: string,
    input: NoteThreadInput,
  ): Promise<NoteThreadAnswer> {
    await this.assertManager(managerRunId);
    const found = await this.resolve(
      input.thread,
      await this.nameable(managerRunId),
    );
    if (!('thread' in found)) {
      return { status: 'unresolved', ...found };
    }
    const note = input.note?.trim() ? input.note.trim() : null;
    await this.roster.setNote(managerRunId, found.thread.runId, note);
    this.events.publishChanged([found.thread.runId], 'roster');
    return {
      status: 'noted',
      handle: found.thread.handle,
      title: found.thread.title,
    };
  }

  /**
   * Archive each named thread the way the sidebar does, after every name has
   * resolved; an archived thread leaves the roster at once.
   */
  async archive(
    managerRunId: string,
    input: ArchiveThreadsInput,
  ): Promise<ArchiveThreadsAnswer> {
    await this.assertManager(managerRunId);
    const rosterThreads = await this.managers.rosterThreads(managerRunId);
    const roster = nameableOf(rosterThreads);
    const shelved = new Set(
      rosterThreads
        .filter(({ run }) => Boolean(run?.archivedAt))
        .map(({ entry }) => entry.threadRunId),
    );
    let shelvedRoster: NameableThread[] | null = null;
    const resolved: { to: string; thread: NameableThread }[] = [];
    const unresolved: Unresolved[] = [];
    for (const to of input.threads) {
      const found = await this.resolve(to, roster, false);
      if ('thread' in found) {
        resolved.push({ to, thread: found.thread });
        continue;
      }
      shelvedRoster ??= await this.archivedFormerThreads(managerRunId, roster);
      const former = resolveTarget(to, shelvedRoster);
      if (former.kind === 'resolved') {
        shelved.add(former.thread.runId);
        resolved.push({ to, thread: former.thread });
      } else {
        unresolved.push({ to, ...found });
      }
    }
    if (unresolved.length > 0) {
      return { archived: [], unresolved };
    }
    const archived: ArchiveThreadsAnswer['archived'] = [];
    const left: string[] = [];
    const seen = new Set<string>();
    for (const { to, thread } of resolved) {
      if (seen.has(thread.runId)) {
        continue;
      }
      seen.add(thread.runId);
      const row = {
        to,
        handle: thread.handle,
        runId: thread.runId,
        title: thread.title,
      };
      if (thread.runId === managerRunId) {
        archived.push({ ...row, outcome: 'refused', code: 'OWN_RUN' });
        continue;
      }
      if (shelved.has(thread.runId)) {
        left.push(thread.runId);
        archived.push({ ...row, outcome: 'already_archived', code: null });
        continue;
      }
      try {
        await this.chats.archive(thread.runId);
        left.push(thread.runId);
        archived.push({ ...row, outcome: 'archived', code: null });
      } catch (error) {
        archived.push({
          ...row,
          outcome: 'refused',
          code:
            error instanceof BaseException ? error.errorCode : 'ARCHIVE_FAILED',
        });
      }
    }
    if (left.length > 0) {
      await this.roster.leave(managerRunId, left, new Date());
      this.events.publishChanged(left, 'roster');
    }
    return { archived, unresolved: [] };
  }

  /**
   * The graph as the user sees it on the board: every active thread, the
   * roster brought in line first so each carries its handle, finished threads
   * last.
   */
  async read(managerRunId: string): Promise<ReadCommandCenterAnswer> {
    await this.assertManager(managerRunId);
    await this.managers.rosterThreads(managerRunId);
    const board = await this.board.board();
    const threads = board.cards.map(graphThreadOf);
    return {
      generatedAt: board.generatedAt,
      threads: [
        ...threads.filter((thread) => thread.column !== 'done'),
        ...threads.filter((thread) => thread.column === 'done'),
      ],
      pendingStarts: board.pendingStarts,
    };
  }

  /**
   * The threads that left this manager's roster because they were archived —
   * by an earlier call, or by the user from the sidebar — still nameable, so
   * archiving one again is answered as already done rather than as unknown.
   */
  private async archivedFormerThreads(
    managerRunId: string,
    roster: readonly NameableThread[],
  ): Promise<NameableThread[]> {
    const onRoster = new Set(roster.map((thread) => thread.runId));
    const former = (await this.roster.listOf(managerRunId)).filter(
      (row) => !onRoster.has(row.threadRunId),
    );
    if (former.length === 0) {
      return [];
    }
    const archived = await this.runDao.getAll(
      {
        id: { $in: former.map((row) => row.threadRunId) },
        archivedAt: { $ne: null },
      },
      undefined,
      this.em.fork(),
    );
    const titles = new Map(archived.map((run) => [run.id, run.title]));
    return former.flatMap((row) =>
      titles.has(row.threadRunId)
        ? [
            {
              handle: row.handle,
              runId: row.threadRunId,
              title: titles.get(row.threadRunId) ?? UNTITLED_THREAD,
              done: false,
            },
          ]
        : [],
    );
  }

  private async assertManager(managerRunId: string): Promise<void> {
    const run = await this.runDao.getById(managerRunId, this.em.fork());
    if (run === null || run.commandCenter !== true) {
      throw new Error('only the command center manager may call this tool');
    }
  }

  private async nameable(managerRunId: string): Promise<NameableThread[]> {
    return nameableOf(await this.managers.rosterThreads(managerRunId));
  }

  /** A name on the roster, or why not — `NOT_MANAGED` for a thread that exists off it. */
  private async resolve(
    name: string,
    roster: readonly NameableThread[],
    preferUnfinished = true,
  ): Promise<{ thread: NameableThread } | Omit<Unresolved, 'to'>> {
    const resolution = resolveTarget(name, roster, preferUnfinished);
    if (resolution.kind === 'resolved') {
      return { thread: resolution.thread };
    }
    if (resolution.kind === 'ambiguous') {
      return {
        code: 'AMBIGUOUS_TARGET',
        candidates: candidatesOf(resolution.candidates),
      };
    }
    const existing = await this.runDao.getById(name.trim(), this.em.fork());
    return {
      code:
        existing !== null && isMessageableThread(existing)
          ? 'NOT_MANAGED'
          : 'THREAD_NOT_FOUND',
      candidates: candidatesOf(resolution.candidates),
    };
  }
}

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import type { RunWire, ThreadContact } from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { ChatService } from '../../agents/services/chat.service';
import { ThreadInboxService } from '../../agents/services/thread-inbox.service';
import { TaskDao } from '../../tasks/dao/task.dao';
import { TeamExecutorService } from '../../teams/services/team-executor.service';
import {
  type CommandCenterBoard,
  type CommandCenterCard,
  type CommandCenterColumn,
  CONTACT_LOOKBACK_MS,
} from '../command-center.types';
import { CommandCenterRosterDao } from '../dao/command-center-roster.dao';
import { CommandCenterThreadStartDao } from '../dao/command-center-thread-start.dao';
import type { CommandCenterRosterEntry } from '../entity/command-center-roster.entity';
import { boardColumnOf } from '../utils/board-column';
import { cardsByRun, taskRefOf } from '../utils/task-ref';
import { threadReportOf } from '../utils/thread-report';

const ACTIVITY_MAX = 140;

/** The threads a board shows, read once, before anything is folded. */
export interface ActiveThreads {
  managerRunId: string | null;
  runs: RunWire[];
}

function activityOf(run: RunWire): string | null {
  const line = run.lastMessage?.replace(/\s+/g, ' ').trim() ?? '';
  if (line === '') {
    return null;
  }
  return line.length > ACTIVITY_MAX
    ? `${line.slice(0, ACTIVITY_MAX - 1)}…`
    : line;
}

/**
 * The command center's board: every active thread — every chat and team run
 * not archived, finished or not, however long ago it last moved — as a card
 * with its column and its contact with the manager. Everything is folded
 * here, over every row, never in the renderer.
 */
@Injectable()
export class CommandCenterService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly chats: ChatService,
    private readonly executor: TeamExecutorService,
    private readonly inbox: ThreadInboxService,
    private readonly taskDao: TaskDao,
    private readonly roster: CommandCenterRosterDao,
    private readonly threadStarts: CommandCenterThreadStartDao,
  ) {}

  /** The manager chat's run id, or null while there is none. */
  async managerRunId(): Promise<string | null> {
    const [run] = await this.runDao.listCommandCenterChats(this.em.fork());
    return run?.id ?? null;
  }

  /**
   * Every active thread, or exactly `runIds` when given — still held to what
   * the board shows: never an app-own chat, never the manager, never an
   * archived thread. A finished thread stays until it is archived.
   */
  async activeThreads(runIds?: readonly string[]): Promise<ActiveThreads> {
    const managerRunId = await this.managerRunId();
    const page =
      runIds === undefined
        ? {}
        : { runIds: runIds.filter((id) => id !== managerRunId) };
    const [chats, teams] = await Promise.all([
      this.chats.listChats('active', page),
      this.executor.listRuns('active', page),
    ]);
    return {
      managerRunId,
      runs: [...chats, ...teams].filter((run) => run.id !== managerRunId),
    };
  }

  /** Each run's board column, by run id. */
  async columnsOf(
    runs: readonly RunWire[],
  ): Promise<Map<string, CommandCenterColumn>> {
    const taskOf = cardsByRun(
      await this.taskDao.listByRunIds(
        runs.map((run) => run.id),
        this.em.fork(),
      ),
    );
    return new Map(
      runs.map((run) => [
        run.id,
        boardColumnOf(run, taskOf.get(run.id)?.status ?? null),
      ]),
    );
  }

  async board(runIds?: readonly string[]): Promise<CommandCenterBoard> {
    const now = Date.now();
    const [{ managerRunId, runs }, manager, pendingStarts, waitingThreads] =
      await Promise.all([
        this.activeThreads(runIds),
        this.chats.findCommandCenterChat(),
        this.taskDao.listPendingStartRequests(this.em.fork()),
        this.threadStarts.listWaiting(),
      ]);
    return {
      generatedAt: new Date(now).toISOString(),
      manager,
      pendingStarts:
        managerRunId === null
          ? 0
          : pendingStarts.filter(
              (task) => task.startRequestedByRunId === managerRunId,
            ).length +
            waitingThreads.filter((row) => row.managerRunId === managerRunId)
              .length,
      cards: await this.cardsOf(managerRunId, runs, now),
    };
  }

  /** Cards for `runs`, newest activity first. */
  async cardsOf(
    managerRunId: string | null,
    runs: readonly RunWire[],
    now: number,
  ): Promise<CommandCenterCard[]> {
    const em = this.em.fork();
    const runIds = runs.map((run) => run.id);
    const [tasks, rosterRows, contacts, awaiting] = await Promise.all([
      this.taskDao.listByRunIds(runIds, em),
      managerRunId === null
        ? Promise.resolve([] as CommandCenterRosterEntry[])
        : this.roster.listOf(managerRunId, em),
      managerRunId === null
        ? Promise.resolve([] as ThreadContact[])
        : this.inbox.contactsOf(
            managerRunId,
            new Date(now - CONTACT_LOOKBACK_MS),
          ),
      managerRunId === null
        ? Promise.resolve(new Set<string>())
        : this.inbox.awaitingRepliesFrom(managerRunId),
    ]);
    const taskOf = cardsByRun(tasks);
    const columnOf = (run: RunWire): CommandCenterColumn =>
      boardColumnOf(run, taskOf.get(run.id)?.status ?? null);
    const agentMessages = await this.itemDao.latestAgentMessageTextPerRun(
      runs
        .filter(
          (run) =>
            columnOf(run) === 'done' &&
            (run.outcome?.summary?.trim() ?? '') === '',
        )
        .map((run) => run.id),
      em,
    );
    const onRoster = new Map(
      rosterRows
        .filter((row) => row.leftAt === null)
        .map((row) => [row.threadRunId, row]),
    );
    const lastContact = new Map<string, number>();
    for (const contact of contacts) {
      const threadId =
        contact.toRunId === managerRunId ? contact.fromRunId : contact.toRunId;
      const at = contact.createdAt.getTime();
      lastContact.set(threadId, Math.max(lastContact.get(threadId) ?? 0, at));
    }
    const cards = runs.map((run): CommandCenterCard => {
      const entry = onRoster.get(run.id);
      const lastMail = lastContact.get(run.id) ?? null;
      const task = taskOf.get(run.id) ?? null;
      const column = columnOf(run);
      return {
        run,
        task: taskRefOf(run, task),
        handle: entry?.handle ?? null,
        note: entry?.note ?? null,
        column,
        activity: activityOf(run),
        report:
          column === 'done'
            ? threadReportOf(
                run.outcome?.summary,
                agentMessages.get(run.id) ?? null,
              )
            : null,
        contact: {
          lastAt: lastMail === null ? null : new Date(lastMail).toISOString(),
          awaitingReply: awaiting.has(run.id),
        },
      };
    });
    return cards.sort((a, b) =>
      (b.run.lastActivityAt ?? b.run.createdAt).localeCompare(
        a.run.lastActivityAt ?? a.run.createdAt,
      ),
    );
  }
}

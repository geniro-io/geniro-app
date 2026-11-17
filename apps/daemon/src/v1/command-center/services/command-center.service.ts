import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import type { RunWire, ThreadContact } from '../../agents/chat.types';
import { RunDao } from '../../agents/dao/run.dao';
import { ApprovalRegistry } from '../../agents/services/approval-registry';
import { ChatService } from '../../agents/services/chat.service';
import { ThreadInboxService } from '../../agents/services/thread-inbox.service';
import { TaskDao } from '../../tasks/dao/task.dao';
import type { TaskStatus } from '../../tasks/tasks.types';
import { TeamExecutorService } from '../../teams/services/team-executor.service';
import {
  COMMAND_CENTER_WINDOW_MS,
  type CommandCenterBoard,
  type CommandCenterCard,
  type CommandCenterWindow,
  STRIP_SPAN_MS,
} from '../command-center.types';
import { CommandCenterRosterDao } from '../dao/command-center-roster.dao';
import { CommandCenterStripDao } from '../dao/command-center-strip.dao';
import type { CommandCenterRosterEntry } from '../entity/command-center-roster.entity';
import { boardColumnOf } from '../utils/board-column';
import { foldThreadStrip } from '../utils/thread-strip-fold';

const ACTIVITY_MAX = 140;

type ManagerMail = { at: number; direction: 'out' | 'in' };

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
 * The command center's board: every active thread — working, waiting on the
 * user, or with activity in the window — as a card with its column, its
 * timeline strip and its contact with the manager. Everything is folded here,
 * over every row in range, never in the renderer.
 */
@Injectable()
export class CommandCenterService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly chats: ChatService,
    private readonly executor: TeamExecutorService,
    private readonly approvals: ApprovalRegistry,
    private readonly inbox: ThreadInboxService,
    private readonly taskDao: TaskDao,
    private readonly roster: CommandCenterRosterDao,
    private readonly strips: CommandCenterStripDao,
  ) {}

  /** The manager chat's run id, or null while there is none. */
  async managerRunId(): Promise<string | null> {
    const [run] = await this.runDao.listCommandCenterChats(this.em.fork());
    return run?.id ?? null;
  }

  /**
   * The threads active in `window`, or exactly `runIds` when given (still
   * held to what the board shows: never an app-own chat, never the manager).
   */
  async activeThreads(
    window: CommandCenterWindow,
    runIds?: readonly string[],
  ): Promise<ActiveThreads> {
    const em = this.em.fork();
    const managerRunId = await this.managerRunId();
    const ids = runIds ?? [
      ...new Set([
        ...(await this.runDao.runIdsActiveIn(
          { since: new Date(Date.now() - COMMAND_CENTER_WINDOW_MS[window]) },
          em,
        )),
        ...(await this.runDao.runningIds(em)),
        ...this.approvals.runIdsWithPending(),
      ]),
    ];
    const scoped = ids.filter((id) => id !== managerRunId);
    const [chats, teams] = await Promise.all([
      this.chats.listChats('active', { runIds: scoped }),
      this.executor.listRuns('active', { runIds: scoped }),
    ]);
    return { managerRunId, runs: [...chats, ...teams] };
  }

  async board(
    window: CommandCenterWindow,
    runIds?: readonly string[],
  ): Promise<CommandCenterBoard> {
    const now = Date.now();
    const { managerRunId, runs } = await this.activeThreads(window, runIds);
    return {
      generatedAt: new Date(now).toISOString(),
      stripStart: new Date(now - STRIP_SPAN_MS).toISOString(),
      managerRunId,
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
    const start = now - STRIP_SPAN_MS;
    const runIds = runs.map((run) => run.id);
    const [tasks, rosterRows, contacts, awaiting] = await Promise.all([
      this.taskDao.listByRunIds(runIds, em),
      managerRunId === null
        ? Promise.resolve([] as CommandCenterRosterEntry[])
        : this.roster.listOf(managerRunId, em),
      managerRunId === null
        ? Promise.resolve([] as ThreadContact[])
        : this.inbox.contactsOf(managerRunId, new Date(start)),
      managerRunId === null
        ? Promise.resolve(new Set<string>())
        : this.inbox.awaitingRepliesFrom(managerRunId),
    ]);
    const taskStatus = new Map<string, TaskStatus>(
      tasks.flatMap((task) =>
        task.runId === null ? [] : [[task.runId, task.status] as const],
      ),
    );
    const onRoster = new Map(
      rosterRows
        .filter((row) => row.leftAt === null)
        .map((row) => [row.threadRunId, row]),
    );
    const cards = await Promise.all(
      runs.map(async (run): Promise<CommandCenterCard> => {
        const mail = contacts.flatMap((contact): ManagerMail[] => {
          if (contact.toRunId === run.id) {
            return [{ at: contact.createdAt.getTime(), direction: 'out' }];
          }
          return contact.fromRunId === run.id
            ? [{ at: contact.createdAt.getTime(), direction: 'in' }]
            : [];
        });
        const entry = onRoster.get(run.id);
        const lastMail = mail.at(-1)?.at ?? null;
        return {
          run,
          handle: entry?.handle ?? null,
          note: entry?.note ?? null,
          column: boardColumnOf(run, taskStatus.get(run.id) ?? null),
          activity: activityOf(run),
          strip: await this.stripOf(run, start, now, mail, em),
          contact: {
            lastAt: lastMail === null ? null : new Date(lastMail).toISOString(),
            awaitingReply: awaiting.has(run.id),
          },
        };
      }),
    );
    return cards.sort((a, b) =>
      (b.run.lastActivityAt ?? b.run.createdAt).localeCompare(
        a.run.lastActivityAt ?? a.run.createdAt,
      ),
    );
  }

  private async stripOf(
    run: RunWire,
    start: number,
    now: number,
    mail: readonly ManagerMail[],
    em: EntityManager,
  ): Promise<CommandCenterCard['strip']> {
    const floor = await this.strips.lastSeqBefore(run.id, new Date(start), em);
    const rows = await this.strips.stripRows(run.id, floor, em);
    const pullRequests = await Promise.all(
      run.pullRequests
        .filter((pullRequest) => pullRequest.opened && pullRequest.seq > floor)
        .map(async (pullRequest) => {
          const at = await this.strips.timeAtSeq(run.id, pullRequest.seq, em);
          return at === null
            ? []
            : [{ at: at.getTime(), label: `#${pullRequest.number}` }];
        }),
    );
    return foldThreadStrip({
      rows,
      start,
      now,
      running: run.status === 'running',
      awaiting: run.awaiting !== null,
      pullRequests: pullRequests.flat(),
      mail,
    });
  }
}

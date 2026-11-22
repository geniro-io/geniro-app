import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';

import type { RunWire } from '../../agents/chat.types';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ChatService } from '../../agents/services/chat.service';
import { UNTITLED_THREAD } from '../../agents/utils/thread-message-text';
import { TeamExecutorService } from '../../teams/services/team-executor.service';
import type {
  RosterReason,
  StartCommandCenterChatInput,
} from '../command-center.types';
import { CommandCenterRosterDao } from '../dao/command-center-roster.dao';
import type { CommandCenterRosterEntry } from '../entity/command-center-roster.entity';
import { composeManagerBrief } from '../utils/manager-brief';
import { ensureManagerFolder } from '../utils/manager-folder';
import { composeStatusSuffix } from '../utils/status-suffix';
import { CommandCenterService } from './command-center.service';
import { CommandCenterEventBus } from './command-center-events.bus';

const MANAGER_TITLE = 'Command center';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One roster row with the thread it names, as it stands now. */
export interface RosterThread {
  entry: CommandCenterRosterEntry;
  run: RunWire | null;
  /** Whether the thread has finished: its board column is `done` and it did not fail. */
  done: boolean;
}

/**
 * The command center's manager: one ordinary chat for the whole app, hidden
 * from the sidebar (`Run.commandCenter`), and the roster of threads it
 * manages. The roster follows the board's active set, which a thread leaves
 * only when it is archived or deleted. Every change to it rewrites the brief,
 * which respawns the manager's CLI and costs its prompt cache, so statuses,
 * which move all the time, ride each turn's prompt instead.
 */
@Injectable()
export class CommandCenterChatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommandCenterChatService.name);
  private opening: Promise<RunWire> | null = null;
  private subscription: Subscription | null = null;
  private userInstructions = '';

  constructor(
    private readonly em: EntityManager,
    private readonly chats: ChatService,
    private readonly executor: TeamExecutorService,
    private readonly agents: AgentEventBus,
    private readonly roster: CommandCenterRosterDao,
    private readonly board: CommandCenterService,
    private readonly events: CommandCenterEventBus,
  ) {}

  onModuleInit(): void {
    this.chats.useCommandCenter({
      brief: (managerRunId) => this.briefFor(managerRunId),
      statusSuffix: (managerRunId) => this.statusSuffixFor(managerRunId),
    });
    this.subscription = this.agents.allDeleted().subscribe((runId) => {
      void this.roster.deleteOf(runId).catch((error: unknown) => {
        this.logger.warn(
          `roster of ${runId} not dropped with it: ${messageOf(error)}`,
        );
      });
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  /**
   * The manager chat: the one that exists, or a new one. The composer
   * settings apply only to a chat being created.
   */
  open(input: StartCommandCenterChatInput): Promise<RunWire> {
    if (this.opening !== null) {
      return this.opening;
    }
    const started = this.openOnce(input).finally(() => {
      this.opening = null;
    });
    this.opening = started;
    return started;
  }

  /** **Destructive and irreversible**: discard the manager chat and its roster. */
  reset(): Promise<{ deleted: number }> {
    return this.chats.deleteCommandCenterChats();
  }

  /**
   * The user's standing instructions for the manager, pushed by Electron main
   * from settings.json; read into the brief before each manager turn.
   */
  setInstructions(instructions: string): string {
    this.userInstructions = instructions;
    return this.userInstructions;
  }

  /**
   * Put threads on a manager's roster now, for a reason other than activity,
   * with the manager's note when it gave one, watched when it asked to hear
   * when they finish.
   */
  async addToRoster(
    managerRunId: string,
    threadRunIds: readonly string[],
    reason: RosterReason,
    note: string | null = null,
    watch = false,
  ): Promise<void> {
    const joined = await this.roster.join(
      managerRunId,
      threadRunIds,
      reason,
      new Date(),
    );
    if (watch) {
      await this.roster.setWatch(managerRunId, threadRunIds, true);
    }
    if (note !== null) {
      for (const threadRunId of threadRunIds) {
        await this.roster.setNote(managerRunId, threadRunId, note);
      }
    }
    if (joined || note !== null) {
      this.events.publishChanged([...threadRunIds], 'roster');
    }
  }

  /** The roster's threads as they stand, after bringing it in line with the board. */
  async rosterThreads(managerRunId: string): Promise<RosterThread[]> {
    const active = await this.syncRoster(managerRunId);
    const rows = (await this.roster.listOf(managerRunId)).filter(
      (row) => row.leftAt === null,
    );
    const known = new Map(active.map((run) => [run.id, run]));
    const missing = rows
      .map((row) => row.threadRunId)
      .filter((id) => !known.has(id));
    if (missing.length > 0) {
      const [chats, teams] = await Promise.all([
        this.chats.listChats('all', { runIds: missing }),
        this.executor.listRuns('all', { runIds: missing }),
      ]);
      for (const run of [...chats, ...teams]) {
        known.set(run.id, run);
      }
    }
    const runs = rows.flatMap((row) => {
      const run = known.get(row.threadRunId);
      return run === undefined ? [] : [run];
    });
    const columns = await this.board.columnsOf(runs);
    return rows.map((entry) => ({
      entry,
      run: known.get(entry.threadRunId) ?? null,
      done:
        columns.get(entry.threadRunId) === 'done' &&
        known.get(entry.threadRunId)?.status !== 'failed',
    }));
  }

  private async openOnce(input: StartCommandCenterChatInput): Promise<RunWire> {
    const folder = ensureManagerFolder();
    const existing = await this.chats.findCommandCenterChat();
    if (existing !== null) {
      await this.chats.refreshTeamInstructions(
        existing.id,
        await this.briefFor(existing.id),
      );
      const moved = await this.chats.moveChatFolder(existing.id, folder);
      return moved
        ? ((await this.chats.findCommandCenterChat()) ?? existing)
        : existing;
    }
    return this.chats.createChat({
      ...input,
      approval: this.chats.offeredApproval(input.agentKind, input.approval),
      cwd: folder,
      title: MANAGER_TITLE,
      projectId: null,
      groupId: null,
      commandCenter: true,
      teamInstructions: composeManagerBrief([], this.userInstructions),
    });
  }

  /** Bring the roster in line with the board's active set and answer that set. */
  private async syncRoster(managerRunId: string): Promise<RunWire[]> {
    const { runs } = await this.board.activeThreads();
    const rows = await this.roster.listOf(managerRunId);
    const onRoster = new Set(
      rows.filter((row) => row.leftAt === null).map((row) => row.threadRunId),
    );
    const activeIds = new Set(runs.map((run) => run.id));
    const additions = runs
      .map((run) => run.id)
      .filter((id) => !onRoster.has(id));
    const removals = [...onRoster].filter((id) => !activeIds.has(id));
    const now = new Date();
    const added = await this.roster.join(managerRunId, additions, 'auto', now);
    if (removals.length > 0) {
      await this.roster.leave(managerRunId, removals, now);
    }
    if (added || removals.length > 0) {
      this.events.publishChanged([...additions, ...removals], 'roster');
    }
    return runs;
  }

  private async briefFor(managerRunId: string): Promise<string> {
    const threads = await this.rosterThreads(managerRunId);
    return composeManagerBrief(
      threads.map(({ entry, run }) => ({
        handle: entry.handle,
        title: run?.title ?? UNTITLED_THREAD,
        project: run?.project?.name ?? null,
        reason: entry.reason,
        note: entry.note,
      })),
      this.userInstructions,
    );
  }

  private async statusSuffixFor(managerRunId: string): Promise<string | null> {
    const threads = await this.rosterThreads(managerRunId);
    const runs = threads.flatMap(({ run }) => (run === null ? [] : [run]));
    const now = Date.now();
    const cards = await this.board.cardsOf(managerRunId, runs, now);
    const byRun = new Map(cards.map((card) => [card.run.id, card]));
    return composeStatusSuffix(
      threads.flatMap(({ entry, run }) => {
        const card = run === null ? undefined : byRun.get(run.id);
        if (card === undefined) {
          return [];
        }
        const pullRequest = card.run.pullRequests.find((pr) => pr.opened);
        const last = card.run.lastActivityAt;
        return [
          {
            handle: entry.handle,
            column: card.column,
            pullRequest: pullRequest?.number ?? null,
            lastActivityAt: last === null ? null : Date.parse(last),
            awaitingReply: card.contact.awaitingReply,
          },
        ];
      }),
      now,
    );
  }
}

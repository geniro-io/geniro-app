import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConflictException } from '@packages/common';

import { interruptCauseClause } from '../../../utils/stop-cause';
import type { ItemWire, RestartContinuation } from '../../agents/chat.types';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentSessionRegistry } from '../../agents/services/agent-session.registry';
import { ChatService } from '../../agents/services/chat.service';
import { stoppedMonitorsText } from '../../agents/utils/monitor-text';
import {
  readRestartContinuation,
  restartContinuationColumn,
  restartContinuationPrompt,
} from '../../agents/utils/run-restart-continuation';
import {
  callSessionKey,
  nodeSessionKey,
} from '../../agents/utils/session-keys';
import type { AnswerHeldRuns, HeldRun, HeldRunsAnswered } from '../teams.types';
import {
  type HeldRunMessage,
  type RestartContinued,
  TeamExecutorService,
} from './team-executor.service';

/** How long a run still settling a pass is waited for before the next try. */
export const RESTART_CONTINUE_RETRY_MS = 5_000;

/** Tries before a run that stays busy is ended as a stop nobody continues. */
export const RESTART_CONTINUE_ATTEMPTS = 12;

/**
 * Continues, once the daemon listens, every run an update or a deliberate
 * restart cut off: the record the boot reconcile and the monitor sweep wrote
 * on the run (`Run.restartContinuation`). A team run is continued by
 * `TeamExecutorService.continueAfterRestart`; a chat by a turn of geniro's own
 * in its session, opened with the short continuation message. The record is
 * cleared before its work is handed on: what a second stop cuts off is read
 * from the transcript again. A chat the user is already talking to, or whose
 * card waits on them, is left to them, its next turn owed the list of its
 * stopped monitors. A run whose continuation cannot start
 * is ended as a stop nobody continues ends it. A team run a crash cut off is
 * held: the drain leaves it to the user's choice (`answerHeld`), or to the
 * user's next message in it.
 */
@Injectable()
export class RestartContinuationService implements OnModuleInit {
  private readonly logger = new Logger(RestartContinuationService.name);
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly chats: ChatService,
    private readonly teams: TeamExecutorService,
    private readonly sessions: AgentSessionRegistry,
  ) {}

  onModuleInit(): void {
    this.teams.setHeldContinuation(
      (runId, message) => this.continueWithMessage(runId, message),
      async (runId) =>
        (
          await this.answerHeld({ continueRunIds: [], declineRunIds: [runId] })
        ).declined.includes(runId),
    );
  }

  /** Continue every run holding a record — called once, from `onListening`. */
  async drain(): Promise<void> {
    try {
      const runs = await this.runDao.listRunsWithRestartContinuation(
        this.em.fork(),
      );
      for (const run of runs) {
        await this.continueRun(run.id);
      }
    } catch (err) {
      this.logger.error(
        `could not read the runs a restart cut off: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Make every team run's record wait for the user's choice — a boot after a
   * crash, so a continuation an earlier stop owed is not sent unasked.
   */
  async holdTeamContinuations(): Promise<void> {
    const em = this.em.fork();
    for (const run of await this.runDao.listRunsWithRestartContinuation(em)) {
      const record = readRestartContinuation(run.restartContinuation ?? null);
      if (isChatRun(run.teamId) || record === null || record.held) {
        continue;
      }
      await this.runDao.setRestartContinuation(
        run.id,
        restartContinuationColumn({ ...record, held: true }),
        em,
      );
    }
  }

  /** Every team run a crash cut off that waits for the user's choice. */
  async listHeld(): Promise<HeldRun[]> {
    const runs = await this.runDao.listRunsWithRestartContinuation(
      this.em.fork(),
    );
    return runs.flatMap((run) => {
      const record = readRestartContinuation(run.restartContinuation ?? null);
      return isChatRun(run.teamId) ||
        record === null ||
        !record.held ||
        run.archivedAt !== null ||
        run.status === 'cancelled'
        ? []
        : [{ runId: run.id, title: run.title, cause: record.cause }];
    });
  }

  /**
   * The user's choice on held runs: each one to continue is continued as an
   * update continues it, each one declined is ended as a crash ends it. A run
   * no longer held is left alone.
   */
  async answerHeld(choice: AnswerHeldRuns): Promise<HeldRunsAnswered> {
    const held = new Set((await this.listHeld()).map((run) => run.runId));
    const continued = [...new Set(choice.continueRunIds)].filter((runId) =>
      held.delete(runId),
    );
    const declined = [...new Set(choice.declineRunIds)].filter((runId) =>
      held.delete(runId),
    );
    for (const runId of continued) {
      await this.continueRun(runId, true);
    }
    for (const runId of declined) {
      await this.decline(runId);
    }
    return { continued, declined };
  }

  /**
   * A held run the user wrote into, continued with that message: null when it
   * is no longer held. A run whose pass is still finishing stays held and the
   * message is refused `RUN_BUSY`, which its sender queues and sends again.
   */
  private async continueWithMessage(
    runId: string,
    message: HeldRunMessage,
  ): Promise<ItemWire | null> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    const stored = readRestartContinuation(run?.restartContinuation ?? null);
    if (run === null || stored === null || !stored.held) {
      return null;
    }
    const record: RestartContinuation = { ...stored, held: false };
    await this.runDao.setRestartContinuation(runId, null, em);
    let continued: RestartContinued;
    try {
      continued = await this.teams.continueWithMessage(runId, record, message);
    } catch (err) {
      this.logger.error(
        `run ${runId}: could not continue after ${interruptCauseClause(record.cause)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.abandon(runId, record, true);
      throw err;
    }
    if (continued.outcome === 'busy') {
      await this.runDao.setRestartContinuation(
        runId,
        restartContinuationColumn(stored),
        em,
      );
      throw new ConflictException(
        'RUN_BUSY',
        'this run is still finishing — your message goes out once it has',
      );
    }
    return continued.item;
  }

  private async decline(runId: string): Promise<void> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    const record = readRestartContinuation(run?.restartContinuation ?? null);
    if (run === null || record === null || !record.held) {
      return;
    }
    await this.runDao.setRestartContinuation(runId, null, em);
    const clause = interruptCauseClause(record.cause);
    const byConversation = new Map<string, typeof record.monitors>();
    for (const monitor of record.monitors) {
      if (monitor.memberId === null) {
        continue;
      }
      const key =
        monitor.conversationId === null
          ? nodeSessionKey(runId, monitor.memberId)
          : callSessionKey(runId, monitor.conversationId);
      byConversation.set(key, [...(byConversation.get(key) ?? []), monitor]);
    }
    for (const [key, monitors] of byConversation) {
      this.sessions.oweKeyNote(
        key,
        `[geniro] ${clause.charAt(0).toUpperCase()}${clause.slice(1)}, which stopped your monitors. ${stoppedMonitorsText(monitors)}`,
      );
    }
    if (run.status === 'running') {
      await this.teams.abandonRestartContinuation(runId, record.cause, true);
    }
  }

  private async continueRun(runId: string, chosen = false): Promise<void> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    const stored = readRestartContinuation(run?.restartContinuation ?? null);
    if (run === null || stored === null) {
      if (run !== null && run.restartContinuation !== null) {
        await this.runDao.setRestartContinuation(runId, null, em);
      }
      return;
    }
    if (stored.held && !chosen) {
      if (run.archivedAt !== null || run.status === 'cancelled') {
        await this.runDao.setRestartContinuation(runId, null, em);
      }
      return;
    }
    const record: RestartContinuation = { ...stored, held: false };
    await this.runDao.setRestartContinuation(runId, null, em);
    try {
      const outcome = isChatRun(run.teamId)
        ? await this.continueChat(runId, record)
        : await this.teams.continueAfterRestart(runId, record);
      if (outcome === 'busy') {
        await this.retryLater(runId, record);
        return;
      }
      this.attempts.delete(runId);
    } catch (err) {
      this.logger.error(
        `run ${runId}: could not continue after ${interruptCauseClause(record.cause)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.abandon(runId, record, !isChatRun(run.teamId));
    }
  }

  /**
   * A chat's cut-off turn, continued in its session. Left to the user when a
   * turn of theirs already runs or a card waits on them.
   */
  private async continueChat(
    runId: string,
    record: RestartContinuation,
  ): Promise<'continued' | 'busy' | 'gone'> {
    const clause = interruptCauseClause(record.cause);
    const leftToUser = (): 'gone' => {
      if (record.monitors.length > 0) {
        this.sessions.oweKeyNote(
          runId,
          `[geniro] ${clause.charAt(0).toUpperCase()}${clause.slice(1)}, which stopped your monitors. ${stoppedMonitorsText(record.monitors)}`,
        );
      }
      return 'gone';
    };
    if (this.chats.hostTurnHold(runId) !== null) {
      return leftToUser();
    }
    try {
      await this.chats.sendMessage(
        runId,
        restartContinuationPrompt(record.cause, {
          working: record.turns.length > 0 ? 'turn' : 'idle',
          calls: [],
          monitors: record.monitors,
        }),
        [],
        {
          ownTurn: true,
          hostRow: {
            severity: 'info',
            message: `${clause.charAt(0).toUpperCase()}${clause.slice(1)} — continuing this chat.`,
            woke: true,
          },
        },
      );
    } catch (err) {
      if (err instanceof ConflictException && err.errorCode === 'RUN_BUSY') {
        return leftToUser();
      }
      if (
        err instanceof ConflictException &&
        err.errorCode === 'RUN_ARCHIVED'
      ) {
        return 'gone';
      }
      throw err;
    }
    return 'continued';
  }

  private async retryLater(
    runId: string,
    record: RestartContinuation,
  ): Promise<void> {
    const tried = (this.attempts.get(runId) ?? 0) + 1;
    if (tried >= RESTART_CONTINUE_ATTEMPTS) {
      this.attempts.delete(runId);
      await this.abandon(runId, record, true);
      return;
    }
    this.attempts.set(runId, tried);
    await this.runDao.setRestartContinuation(
      runId,
      restartContinuationColumn(record),
      this.em.fork(),
    );
    const timer = setTimeout(
      () => void this.continueRun(runId),
      RESTART_CONTINUE_RETRY_MS,
    );
    timer.unref();
  }

  private async abandon(
    runId: string,
    record: RestartContinuation,
    isTeam: boolean,
  ): Promise<void> {
    try {
      if (isTeam) {
        await this.teams.abandonRestartContinuation(runId, record.cause);
      } else {
        await this.chats.abandonRestartContinuation(runId, record.cause);
      }
    } catch (err) {
      this.logger.error(
        `run ${runId}: could not end the run its continuation failed for: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function isChatRun(teamId: string | null | undefined): boolean {
  return teamId === null || teamId === undefined;
}

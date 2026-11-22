import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import { ConflictException } from '@packages/common';

import { interruptCauseClause } from '../../../utils/stop-cause';
import type { RestartContinuation } from '../../agents/chat.types';
import { RunDao } from '../../agents/dao/run.dao';
import { ChatService } from '../../agents/services/chat.service';
import {
  readRestartContinuation,
  restartContinuationColumn,
  restartContinuationPrompt,
} from '../../agents/utils/run-restart-continuation';
import { TeamExecutorService } from './team-executor.service';

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
 * card waits on them, is left to them. A run whose continuation cannot start
 * is ended as a stop nobody continues ends it.
 */
@Injectable()
export class RestartContinuationService {
  private readonly logger = new Logger(RestartContinuationService.name);
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly chats: ChatService,
    private readonly teams: TeamExecutorService,
  ) {}

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

  private async continueRun(runId: string): Promise<void> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    const record = readRestartContinuation(run?.restartContinuation ?? null);
    if (run === null || record === null) {
      if (run !== null && run.restartContinuation !== null) {
        await this.runDao.setRestartContinuation(runId, null, em);
      }
      return;
    }
    await this.runDao.setRestartContinuation(runId, null, em);
    try {
      const outcome =
        run.teamId === null || run.teamId === undefined
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
      await this.abandon(runId, record, run.teamId != null);
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
    if (this.chats.hostTurnHold(runId) !== null) {
      return 'gone';
    }
    const clause = interruptCauseClause(record.cause);
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
      if (
        err instanceof ConflictException &&
        (err.errorCode === 'RUN_BUSY' || err.errorCode === 'RUN_ARCHIVED')
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

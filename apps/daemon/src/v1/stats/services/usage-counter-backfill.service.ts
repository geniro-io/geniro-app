import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { RunDao } from '../../agents/dao/run.dao';
import { UsageCounterDao } from '../dao/usage-counter.dao';
import type {
  ToolCallJournalRow,
  UsageCounterBackfillState,
  UsageCounterRow,
} from '../stats.types';

/** Journal rows one backfill window reads and folds in one transaction. */
export const USAGE_BACKFILL_WINDOW = 5000;

/**
 * Folds the tool journal into the counters once: every `tool_call_events`
 * row before the cutoff written at the first boot of this build, window by
 * window in `(occurred_at, id)` order. Each window's counts and its new
 * cursor commit in one transaction, so a pass killed anywhere resumes without
 * counting a row twice; rows at or after the cutoff are counted live.
 */
@Injectable()
export class UsageCounterBackfillService implements OnModuleInit {
  private readonly logger = new Logger(UsageCounterBackfillService.name);
  private state: UsageCounterBackfillState | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly dao: UsageCounterDao,
    private readonly runs: RunDao,
  ) {}

  async onModuleInit(): Promise<void> {
    this.state = await this.dao.ensureBackfill(Date.now());
  }

  /** Before it, a journal row belongs to the backfill; null until the boot read it. */
  get cutoff(): number | null {
    return this.state?.cutoff ?? null;
  }

  get done(): boolean {
    return this.state?.doneAt !== null && this.state?.doneAt !== undefined;
  }

  /** The boot entry point, off the ready path. Never throws. */
  async runQuietly(): Promise<void> {
    try {
      while (await this.foldWindow()) {
        await yieldToEventLoop();
      }
    } catch (err) {
      this.logger.error(
        `tool usage backfill stopped at ${JSON.stringify(this.state?.cursor ?? null)}; the tool log is not pruned until it finishes, and it resumes next launch: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Fold the next window; false once nothing is left. */
  async foldWindow(): Promise<boolean> {
    const state = this.state ?? (await this.dao.ensureBackfill(Date.now()));
    this.state = state;
    if (state.doneAt !== null) {
      return false;
    }
    const em = this.em.fork();
    const rows = await this.dao.journalWindow(
      state.cutoff,
      state.cursor,
      USAGE_BACKFILL_WINDOW,
      em,
    );
    const last = rows.at(-1);
    if (last === undefined) {
      const at = Date.now();
      await this.dao.finishBackfill(at, em);
      this.state = { ...state, doneAt: at };
      return false;
    }
    const projects = new Map(
      (
        await this.runs.usageFacts(
          [...new Set(rows.map((row) => row.runId))],
          em,
        )
      ).map((run) => [run.id, run.projectId ?? '']),
    );
    const counts = rows.map((row) => journalCount(row, projects));
    const cursor = { occurredAt: last.occurredAt, id: last.id };
    await em.transactional(async (tx) => {
      await this.dao.add(counts, tx);
      await this.dao.moveBackfillCursor(cursor, tx);
    });
    this.state = { ...state, cursor };
    return true;
  }
}

function journalCount(
  row: ToolCallJournalRow,
  projects: ReadonlyMap<string, string>,
): UsageCounterRow {
  const timed = row.durationMs !== null;
  return {
    subjectKind: 'tool',
    subject: row.tool,
    source: row.mcpServer ?? '',
    agentKind: row.agentKind ?? '',
    origin: 'direct',
    projectId: projects.get(row.runId) ?? '',
    calls: 1,
    errors: row.ok ? 0 : 1,
    refused: 0,
    durationMsTotal: timed ? Math.max(0, row.durationMs ?? 0) : 0,
    timedCalls: timed ? 1 : 0,
    resultCharsTotal: 0,
    sizedCalls: 0,
    offeredSessions: 0,
    firstAt: row.occurredAt,
    lastAt: row.occurredAt,
  };
}

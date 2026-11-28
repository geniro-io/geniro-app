import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { UsageCounter } from '../entity/usage-counter.entity';
import { UsageSubject } from '../entity/usage-subject.entity';
import type {
  ToolCallJournalRow,
  UsageCounterBackfillState,
  UsageCounterRow,
  UsageSubjectKind,
  UsageSubjectRow,
} from '../stats.types';
import { mergeCounterRows } from '../utils/usage-counter-delta';

/** The counter tables and the journal as SQLite stores them; dates are epoch ms. */
interface UsageCounterDatabase {
  usage_counters: {
    subject_kind: UsageCounter['subjectKind'];
    subject: string;
    source: string;
    agent_kind: string;
    origin: UsageCounter['origin'];
    project_id: string;
    calls: number;
    errors: number;
    refused: number;
    duration_ms_total: number;
    timed_calls: number;
    result_chars_total: number;
    sized_calls: number;
    offered_sessions: number;
    first_at: number | null;
    last_at: number | null;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
  };
  usage_subjects: {
    subject_kind: UsageSubject['subjectKind'];
    subject: string;
    source: string;
    first_known_at: number;
    last_known_at: number;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
  };
  usage_counter_backfill: {
    source: string;
    cutoff: number;
    cursor_occurred_at: number | null;
    cursor_id: string | null;
    done_at: number | null;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
  };
  tool_call_events: {
    id: string;
    run_id: string;
    occurred_at: number;
    agent_kind: string | null;
    tool: string;
    mcp_server: string | null;
    ok: number;
    duration_ms: number | null;
    deleted_at: number | null;
  };
}

/** Rows per {@link UsageCounterDao.add} statement — 19 bound values each. */
export const USAGE_COUNTER_ADD_BATCH = 500;

/** The journal the backfill folds and the retention sweep prunes. */
const JOURNAL_SOURCE = 'tool_call_events';

/** Most journal rows one retention delete removes. */
export const JOURNAL_DELETE_WINDOW_MAX = 1000;

@Injectable()
export class UsageCounterDao extends BaseDao<UsageCounter> {
  constructor(em: EntityManager) {
    super(em, UsageCounter);
  }

  /**
   * Add these deltas onto the counters, one statement per
   * {@link USAGE_COUNTER_ADD_BATCH} rows: every count is added onto the stored
   * one, `first_at` keeps the earlier and `last_at` the later, so concurrent
   * writers never overwrite each other.
   */
  async add(
    rows: readonly UsageCounterRow[],
    txEm?: EntityManager,
  ): Promise<void> {
    const merged = mergeCounterRows(rows);
    const db = this.db(txEm);
    const now = Date.now();
    for (let at = 0; at < merged.length; at += USAGE_COUNTER_ADD_BATCH) {
      await db
        .insertInto('usage_counters')
        .values(
          merged.slice(at, at + USAGE_COUNTER_ADD_BATCH).map((row) => ({
            subject_kind: row.subjectKind,
            subject: row.subject,
            source: row.source,
            agent_kind: row.agentKind,
            origin: row.origin,
            project_id: row.projectId,
            calls: row.calls,
            errors: row.errors,
            refused: row.refused,
            duration_ms_total: row.durationMsTotal,
            timed_calls: row.timedCalls,
            result_chars_total: row.resultCharsTotal,
            sized_calls: row.sizedCalls,
            offered_sessions: row.offeredSessions,
            first_at: row.firstAt,
            last_at: row.lastAt,
            created_at: now,
            updated_at: now,
            deleted_at: null,
          })),
        )
        .onConflict((conflict) =>
          conflict
            .columns([
              'subject_kind',
              'subject',
              'source',
              'agent_kind',
              'origin',
              'project_id',
            ])
            .doUpdateSet((eb) => ({
              calls: eb('usage_counters.calls', '+', eb.ref('excluded.calls')),
              errors: eb(
                'usage_counters.errors',
                '+',
                eb.ref('excluded.errors'),
              ),
              refused: eb(
                'usage_counters.refused',
                '+',
                eb.ref('excluded.refused'),
              ),
              duration_ms_total: eb(
                'usage_counters.duration_ms_total',
                '+',
                eb.ref('excluded.duration_ms_total'),
              ),
              timed_calls: eb(
                'usage_counters.timed_calls',
                '+',
                eb.ref('excluded.timed_calls'),
              ),
              result_chars_total: eb(
                'usage_counters.result_chars_total',
                '+',
                eb.ref('excluded.result_chars_total'),
              ),
              sized_calls: eb(
                'usage_counters.sized_calls',
                '+',
                eb.ref('excluded.sized_calls'),
              ),
              offered_sessions: eb(
                'usage_counters.offered_sessions',
                '+',
                eb.ref('excluded.offered_sessions'),
              ),
              first_at: eb.fn('min', [
                eb.fn.coalesce('usage_counters.first_at', 'excluded.first_at'),
                eb.fn.coalesce('excluded.first_at', 'usage_counters.first_at'),
              ]),
              last_at: eb.fn('max', [
                eb.fn.coalesce('usage_counters.last_at', 'excluded.last_at'),
                eb.fn.coalesce('excluded.last_at', 'usage_counters.last_at'),
              ]),
              updated_at: now,
            })),
        )
        .execute();
    }
  }

  async rows(txEm?: EntityManager): Promise<UsageCounterRow[]> {
    const rows = await this.db(txEm)
      .selectFrom('usage_counters')
      .selectAll()
      .where('deleted_at', 'is', null)
      .execute();
    return rows.map(counterRowOf);
  }

  async rowsOfSubject(
    subject: { subjectKind: UsageSubjectKind; subject: string; source: string },
    txEm?: EntityManager,
  ): Promise<UsageCounterRow[]> {
    const rows = await this.db(txEm)
      .selectFrom('usage_counters')
      .selectAll()
      .where('deleted_at', 'is', null)
      .where('subject_kind', '=', subject.subjectKind)
      .where('subject', '=', subject.subject)
      .where('source', '=', subject.source)
      .execute();
    return rows.map(counterRowOf);
  }

  /** Mark these subjects known at `at`; a known one keeps its first boot. */
  async registerSubjects(
    subjects: readonly Pick<
      UsageSubjectRow,
      'subjectKind' | 'subject' | 'source'
    >[],
    at: number,
    txEm?: EntityManager,
  ): Promise<void> {
    const db = this.db(txEm);
    for (let i = 0; i < subjects.length; i += USAGE_COUNTER_ADD_BATCH) {
      await db
        .insertInto('usage_subjects')
        .values(
          subjects.slice(i, i + USAGE_COUNTER_ADD_BATCH).map((subject) => ({
            subject_kind: subject.subjectKind,
            subject: subject.subject,
            source: subject.source,
            first_known_at: at,
            last_known_at: at,
            created_at: at,
            updated_at: at,
            deleted_at: null,
          })),
        )
        .onConflict((conflict) =>
          conflict
            .columns(['subject_kind', 'subject', 'source'])
            .doUpdateSet((eb) => ({
              last_known_at: eb.fn('max', [
                'usage_subjects.last_known_at',
                eb.ref('excluded.last_known_at'),
              ]),
              updated_at: at,
            })),
        )
        .execute();
    }
  }

  async subjects(txEm?: EntityManager): Promise<UsageSubjectRow[]> {
    const rows = await this.db(txEm)
      .selectFrom('usage_subjects')
      .selectAll()
      .where('deleted_at', 'is', null)
      .execute();
    return rows.map((row) => ({
      subjectKind: row.subject_kind,
      subject: row.subject,
      source: row.source,
      firstKnownAt: Number(row.first_known_at),
      lastKnownAt: Number(row.last_known_at),
    }));
  }

  async backfillState(
    txEm?: EntityManager,
  ): Promise<UsageCounterBackfillState | null> {
    const row = await this.db(txEm)
      .selectFrom('usage_counter_backfill')
      .selectAll()
      .where('source', '=', JOURNAL_SOURCE)
      .executeTakeFirst();
    if (row === undefined) {
      return null;
    }
    return {
      cutoff: Number(row.cutoff),
      cursor:
        row.cursor_occurred_at === null || row.cursor_id === null
          ? null
          : { occurredAt: Number(row.cursor_occurred_at), id: row.cursor_id },
      doneAt: row.done_at === null ? null : Number(row.done_at),
    };
  }

  /** The backfill's row, written with this cutoff unless one already stands. */
  async ensureBackfill(
    cutoff: number,
    txEm?: EntityManager,
  ): Promise<UsageCounterBackfillState> {
    await this.db(txEm)
      .insertInto('usage_counter_backfill')
      .values({
        source: JOURNAL_SOURCE,
        cutoff,
        cursor_occurred_at: null,
        cursor_id: null,
        done_at: null,
        created_at: cutoff,
        updated_at: cutoff,
        deleted_at: null,
      })
      .onConflict((conflict) => conflict.column('source').doNothing())
      .execute();
    const state = await this.backfillState(txEm);
    return state ?? { cutoff, cursor: null, doneAt: null };
  }

  async moveBackfillCursor(
    cursor: { occurredAt: number; id: string },
    txEm: EntityManager,
  ): Promise<void> {
    await this.db(txEm)
      .updateTable('usage_counter_backfill')
      .set({
        cursor_occurred_at: cursor.occurredAt,
        cursor_id: cursor.id,
        updated_at: Date.now(),
      })
      .where('source', '=', JOURNAL_SOURCE)
      .execute();
  }

  async finishBackfill(at: number, txEm?: EntityManager): Promise<void> {
    await this.db(txEm)
      .updateTable('usage_counter_backfill')
      .set({ done_at: at, updated_at: at })
      .where('source', '=', JOURNAL_SOURCE)
      .execute();
  }

  /** The next journal rows before `cutoff`, after `cursor` in `(occurred_at, id)` order. */
  async journalWindow(
    cutoff: number,
    cursor: { occurredAt: number; id: string } | null,
    limit: number,
    txEm?: EntityManager,
  ): Promise<ToolCallJournalRow[]> {
    let query = this.db(txEm)
      .selectFrom('tool_call_events')
      .select([
        'id',
        'run_id',
        'occurred_at',
        'agent_kind',
        'tool',
        'mcp_server',
        'ok',
        'duration_ms',
      ])
      .where('deleted_at', 'is', null)
      .where('occurred_at', '<', cutoff);
    if (cursor !== null) {
      query = query.where((eb) =>
        eb.or([
          eb('occurred_at', '>', cursor.occurredAt),
          eb.and([
            eb('occurred_at', '=', cursor.occurredAt),
            eb('id', '>', cursor.id),
          ]),
        ]),
      );
    }
    const rows = await query
      .orderBy('occurred_at', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      occurredAt: Number(row.occurred_at),
      agentKind: row.agent_kind,
      tool: row.tool,
      mcpServer: row.mcp_server,
      ok: row.ok !== 0,
      durationMs: row.duration_ms,
    }));
  }

  /** Delete at most `limit` journal rows older than `before`; how many went. */
  async deleteJournalBefore(
    before: number,
    limit: number,
    txEm?: EntityManager,
  ): Promise<number> {
    const db = this.db(txEm);
    const ids = await db
      .selectFrom('tool_call_events')
      .select('id')
      .where('occurred_at', '<', before)
      .orderBy('occurred_at', 'asc')
      .limit(Math.min(limit, JOURNAL_DELETE_WINDOW_MAX))
      .execute();
    if (ids.length === 0) {
      return 0;
    }
    await db
      .deleteFrom('tool_call_events')
      .where(
        'id',
        'in',
        ids.map((row) => row.id),
      )
      .execute();
    return ids.length;
  }

  private db(txEm?: EntityManager) {
    return (txEm ?? this.em.fork()).getKysely<UsageCounterDatabase>({
      convertValues: false,
    });
  }
}

function counterRowOf(
  row: UsageCounterDatabase['usage_counters'],
): UsageCounterRow {
  return {
    subjectKind: row.subject_kind,
    subject: row.subject,
    source: row.source,
    agentKind: row.agent_kind,
    origin: row.origin,
    projectId: row.project_id,
    calls: Number(row.calls),
    errors: Number(row.errors),
    refused: Number(row.refused),
    durationMsTotal: Number(row.duration_ms_total),
    timedCalls: Number(row.timed_calls),
    resultCharsTotal: Number(row.result_chars_total),
    sizedCalls: Number(row.sized_calls),
    offeredSessions: Number(row.offered_sessions),
    firstAt: row.first_at === null ? null : Number(row.first_at),
    lastAt: row.last_at === null ? null : Number(row.last_at),
  };
}

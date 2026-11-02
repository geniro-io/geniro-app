import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { idBatches } from '../../agents/utils/id-batches';
import { ToolCallEvent } from '../entity/tool-call-event.entity';
import type {
  CallLedgerRow,
  StageLedgerRow,
  ThreadOutcomeLedgerRow,
  ToolCallLedgerRow,
} from '../stats.types';
import type { ActivityDatabase } from './usage-activity.dao';

/**
 * The two ledger tables as SQLite stores them, for the typed Kysely reads and writes.
 * Dates are the stored epoch milliseconds and booleans the stored 0/1.
 */
interface MetricDatabase {
  tool_call_events: {
    id: string;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
    run_id: ToolCallEvent['runId'];
    seq: ToolCallEvent['seq'];
    occurred_at: number;
    team_slug: ToolCallEvent['teamSlug'];
    member_id: ToolCallEvent['memberId'];
    agent_kind: ToolCallEvent['agentKind'];
    tool: ToolCallEvent['tool'];
    mcp_server: ToolCallEvent['mcpServer'];
    ok: number;
    duration_ms: ToolCallEvent['durationMs'];
  };
  usage_activity: ActivityDatabase['usage_activity'];
}

/** Which rows a fold reads: every team run, or one team's, over a period or for good. */
export interface LedgerScope {
  teamSlug?: string;
  from?: Date;
  to?: Date;
}

function flag(value: number | null): boolean | null {
  return value === null ? null : value !== 0;
}

/**
 * The write-time ledgers the thread metrics are counted from: one `tool_call_events`
 * row per finished tool call, and `usage_activity` rows of kind `stage`, `call` and
 * `thread_outcome`. Every write is a native insert keyed so a repeat is ignored (or,
 * for an outcome, moves only forward), never a flush.
 */
@Injectable()
export class MetricLedgerDao extends BaseDao<ToolCallEvent> {
  constructor(em: EntityManager) {
    super(em, ToolCallEvent);
  }

  private db(txEm?: EntityManager) {
    return (txEm ?? this.em.fork()).getKysely<MetricDatabase>({
      convertValues: false,
    });
  }

  async insertToolCall(
    row: ToolCallLedgerRow,
    txEm?: EntityManager,
  ): Promise<void> {
    const now = Date.now();
    await this.db(txEm)
      .insertInto('tool_call_events')
      .values({
        id: randomUUID(),
        created_at: now,
        updated_at: now,
        deleted_at: null,
        run_id: row.runId,
        seq: row.seq,
        occurred_at: row.occurredAt.getTime(),
        team_slug: row.teamSlug,
        member_id: row.memberId,
        agent_kind: row.agentKind,
        tool: row.tool,
        mcp_server: row.mcpServer,
        ok: row.ok ? 1 : 0,
        duration_ms: row.durationMs,
      })
      .onConflict((conflict) => conflict.columns(['run_id', 'seq']).doNothing())
      .execute();
  }

  async insertStage(row: StageLedgerRow, txEm?: EntityManager): Promise<void> {
    const now = Date.now();
    await this.db(txEm)
      .insertInto('usage_activity')
      .values({
        id: randomUUID(),
        created_at: now,
        updated_at: now,
        deleted_at: null,
        kind: 'stage',
        run_id: row.runId,
        occurred_at: row.occurredAt.getTime(),
        dedup_key: `stage:${row.runId}:${row.seq}`,
        team_slug: row.teamSlug,
        source_seq: row.seq,
        member_id: row.memberId,
        peer_member_id: row.lead,
        stage_id: row.stageId,
        stage_action: row.action,
        entered_at: row.enteredAt?.getTime() ?? null,
        duration_ms: row.durationMs,
        cost_usd: null,
        turns: null,
        ok: null,
        outcome_kind: null,
      })
      .onConflict((conflict) => conflict.column('dedup_key').doNothing())
      .execute();
  }

  /** When the run's newest stage move before `seq` happened, or null when none is recorded. */
  async lastStageMoveAt(
    runId: string,
    seq: number,
    txEm?: EntityManager,
  ): Promise<Date | null> {
    const row = await this.db(txEm)
      .selectFrom('usage_activity')
      .select('occurred_at')
      .where('kind', '=', 'stage')
      .where('run_id', '=', runId)
      .where('source_seq', '<', seq)
      .where('stage_action', 'in', ['complete', 'skip', 'reopen'])
      .orderBy('source_seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? null : new Date(Number(row.occurred_at));
  }

  async insertCall(row: CallLedgerRow, txEm?: EntityManager): Promise<void> {
    const now = Date.now();
    await this.db(txEm)
      .insertInto('usage_activity')
      .values({
        id: randomUUID(),
        created_at: now,
        updated_at: now,
        deleted_at: null,
        kind: 'call',
        run_id: row.runId,
        occurred_at: row.occurredAt.getTime(),
        dedup_key: `call:${row.runId}:${row.callId}`,
        team_slug: row.teamSlug,
        source_seq: row.seq,
        member_id: row.caller,
        peer_member_id: row.callee,
        stage_id: null,
        stage_action: null,
        entered_at: null,
        duration_ms: row.durationMs,
        cost_usd: row.costUsd,
        turns: row.turns,
        ok: row.ok ? 1 : 0,
        outcome_kind: null,
      })
      .onConflict((conflict) => conflict.column('dedup_key').doNothing())
      .execute();
  }

  /** One run's thread outcome, moved only forward by its source row's seq. */
  async upsertThreadOutcome(
    row: ThreadOutcomeLedgerRow,
    txEm?: EntityManager,
  ): Promise<void> {
    const now = Date.now();
    await this.db(txEm)
      .insertInto('usage_activity')
      .values({
        id: randomUUID(),
        created_at: now,
        updated_at: now,
        deleted_at: null,
        kind: 'thread_outcome',
        run_id: row.runId,
        occurred_at: row.occurredAt.getTime(),
        dedup_key: `thread-outcome:${row.runId}`,
        team_slug: row.teamSlug,
        source_seq: row.seq,
        member_id: row.memberId,
        peer_member_id: null,
        stage_id: null,
        stage_action: null,
        entered_at: null,
        duration_ms: null,
        cost_usd: null,
        turns: null,
        ok: null,
        outcome_kind: row.kind,
      })
      .onConflict((conflict) =>
        conflict
          .column('dedup_key')
          .doUpdateSet((eb) => ({
            updated_at: now,
            occurred_at: eb.ref('excluded.occurred_at'),
            source_seq: eb.ref('excluded.source_seq'),
            member_id: eb.ref('excluded.member_id'),
            outcome_kind: eb.ref('excluded.outcome_kind'),
          }))
          .where((eb) =>
            eb('usage_activity.source_seq', '<', eb.ref('excluded.source_seq')),
          ),
      )
      .execute();
  }

  async toolCalls(
    scope: LedgerScope,
    txEm?: EntityManager,
  ): Promise<ToolCallLedgerRow[]> {
    let query = this.db(txEm)
      .selectFrom('tool_call_events')
      .selectAll()
      .where('deleted_at', 'is', null);
    if (scope.teamSlug !== undefined) {
      query = query.where('team_slug', '=', scope.teamSlug);
    }
    if (scope.from !== undefined) {
      query = query.where('occurred_at', '>=', scope.from.getTime());
    }
    if (scope.to !== undefined) {
      query = query.where('occurred_at', '<', scope.to.getTime());
    }
    return (await query.execute()).map((row) => ({
      runId: row.run_id,
      seq: row.seq,
      occurredAt: new Date(Number(row.occurred_at)),
      teamSlug: row.team_slug,
      memberId: row.member_id,
      agentKind: row.agent_kind,
      tool: row.tool,
      mcpServer: row.mcp_server,
      ok: row.ok !== 0,
      durationMs: row.duration_ms,
    }));
  }

  async stages(
    scope: LedgerScope,
    txEm?: EntityManager,
  ): Promise<StageLedgerRow[]> {
    return (await this.activity('stage', scope, txEm)).map((row) => ({
      runId: row.run_id,
      seq: row.source_seq ?? 0,
      occurredAt: new Date(Number(row.occurred_at)),
      teamSlug: row.team_slug,
      memberId: row.member_id,
      lead: row.peer_member_id,
      stageId: row.stage_id ?? '',
      action: row.stage_action ?? 'complete',
      enteredAt:
        row.entered_at === null ? null : new Date(Number(row.entered_at)),
      durationMs: row.duration_ms,
    }));
  }

  async calls(
    scope: LedgerScope,
    txEm?: EntityManager,
  ): Promise<CallLedgerRow[]> {
    return (await this.activity('call', scope, txEm)).map((row) => ({
      runId: row.run_id,
      seq: row.source_seq ?? 0,
      callId: row.dedup_key.slice(`call:${row.run_id}:`.length),
      occurredAt: new Date(Number(row.occurred_at)),
      teamSlug: row.team_slug,
      caller: row.member_id ?? '',
      callee: row.peer_member_id ?? '',
      durationMs: row.duration_ms,
      costUsd: row.cost_usd,
      turns: row.turns,
      ok: flag(row.ok) ?? false,
    }));
  }

  /** The recorded outcomes of these runs, or of the runs a scope names. */
  async threadOutcomes(
    scope: LedgerScope | { runIds: readonly string[] },
    txEm?: EntityManager,
  ): Promise<ThreadOutcomeLedgerRow[]> {
    const rows =
      'runIds' in scope
        ? (
            await Promise.all(
              idBatches(scope.runIds).map((batch) =>
                this.db(txEm)
                  .selectFrom('usage_activity')
                  .selectAll()
                  .where('kind', '=', 'thread_outcome')
                  .where('deleted_at', 'is', null)
                  .where('run_id', 'in', batch)
                  .execute(),
              ),
            )
          ).flat()
        : await this.activity('thread_outcome', scope, txEm);
    return rows.flatMap((row) =>
      row.outcome_kind === null
        ? []
        : [
            {
              runId: row.run_id,
              seq: row.source_seq ?? 0,
              occurredAt: new Date(Number(row.occurred_at)),
              teamSlug: row.team_slug,
              memberId: row.member_id,
              kind: row.outcome_kind,
            },
          ],
    );
  }

  private async activity(
    kind: 'stage' | 'call' | 'thread_outcome',
    scope: LedgerScope,
    txEm?: EntityManager,
  ) {
    let query = this.db(txEm)
      .selectFrom('usage_activity')
      .selectAll()
      .where('kind', '=', kind)
      .where('deleted_at', 'is', null);
    if (scope.teamSlug !== undefined) {
      query = query.where('team_slug', '=', scope.teamSlug);
    }
    if (scope.from !== undefined) {
      query = query.where('occurred_at', '>=', scope.from.getTime());
    }
    if (scope.to !== undefined) {
      query = query.where('occurred_at', '<', scope.to.getTime());
    }
    return query.orderBy('occurred_at', 'asc').execute();
  }
}

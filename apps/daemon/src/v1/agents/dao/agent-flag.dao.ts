import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { AgentFlag } from '../../runs/entity/agent-flag.entity';
import { idBatches } from '../utils/id-batches';

/** `agent_flags` — one row per flagged problem, kept after its run is deleted. */
@Injectable()
export class AgentFlagDao extends BaseDao<AgentFlag> {
  constructor(em: EntityManager) {
    super(em, AgentFlag);
  }

  /** The run's flags raised at or before `throughSeq`, oldest first. */
  async forRun(
    runId: string,
    throughSeq: number,
    txEm?: EntityManager,
  ): Promise<AgentFlag[]> {
    return this.getRepo(txEm ?? this.em.fork()).find(
      { runId, seq: { $lte: throughSeq } },
      { orderBy: { seq: 'asc', occurredAt: 'asc' }, disableIdentityMap: true },
    );
  }

  /** Every flag raised in `[from, to)`, oldest first. */
  async inPeriod(
    from: Date,
    to: Date,
    txEm?: EntityManager,
  ): Promise<AgentFlag[]> {
    return this.getRepo(txEm ?? this.em.fork()).find(
      { occurredAt: { $gte: from, $lt: to } },
      { orderBy: { occurredAt: 'asc' }, disableIdentityMap: true },
    );
  }

  async byHandles(
    handles: readonly string[],
    txEm?: EntityManager,
  ): Promise<AgentFlag[]> {
    const repo = this.getRepo(txEm ?? this.em.fork());
    return (
      await Promise.all(
        idBatches(handles).map((batch) =>
          repo.find({ handle: { $in: batch } }, { disableIdentityMap: true }),
        ),
      )
    ).flat();
  }

  /** How many flags each of these runs has, runs with none left out. */
  async countsByRun(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<Map<string, number>> {
    const db = (txEm ?? this.em.fork()).getKysely<{
      agent_flags: { run_id: string; deleted_at: number | null };
    }>({ convertValues: false });
    const counts = new Map<string, number>();
    for (const batch of idBatches(runIds)) {
      const rows = await db
        .selectFrom('agent_flags')
        .select((eb) => ['run_id', eb.fn.countAll<number>().as('flags')])
        .where('run_id', 'in', batch)
        .where('deleted_at', 'is', null)
        .groupBy('run_id')
        .execute();
      for (const row of rows) {
        counts.set(row.run_id, Number(row.flags));
      }
    }
    return counts;
  }

  async hasAutoCause(
    runId: string,
    autoCause: string,
    txEm?: EntityManager,
  ): Promise<boolean> {
    return (
      (await this.getRepo(txEm ?? this.em.fork()).count(
        { runId, autoCause },
        { filters: false },
      )) > 0
    );
  }

  /** What one conversation has already raised in this run: its summaries, for the cap and the duplicate check; the daemon's own flags left out. */
  async summariesOf(
    runId: string,
    memberId: string | null,
    conversationId: string | null,
    txEm?: EntityManager,
  ): Promise<{ conversation: string[]; run: string[] }> {
    const rows = await this.getRepo(txEm ?? this.em.fork()).find(
      { runId, automatic: false },
      {
        fields: ['summary', 'memberId', 'conversationId'],
        disableIdentityMap: true,
      },
    );
    return {
      run: rows.map((row) => row.summary),
      conversation: rows
        .filter(
          (row) =>
            row.memberId === memberId && row.conversationId === conversationId,
        )
        .map((row) => row.summary),
    };
  }
}

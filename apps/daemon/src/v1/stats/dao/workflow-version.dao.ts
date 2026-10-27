import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { WorkflowVersion } from '../entity/workflow-version.entity';
import type { WorkflowVersionGraph } from '../stats.types';

/** `workflow_versions` as SQLite stores it; dates are epoch milliseconds, since value conversion is off. */
interface WorkflowVersionDatabase {
  workflow_versions: {
    slug: WorkflowVersion['slug'];
    version: WorkflowVersion['version'];
    graph: WorkflowVersion['graph'];
    first_seen_at: number;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
  };
}

/** The registry of graphs each workflow has run with (see the entity). */
@Injectable()
export class WorkflowVersionDao extends BaseDao<WorkflowVersion> {
  constructor(em: EntityManager) {
    super(em, WorkflowVersion);
  }

  /**
   * Record a version's graph the first time a run of it is seen. A version
   * already recorded keeps its graph and moves `firstSeenAt` only earlier, so
   * the boot sweep may meet a workflow's runs in any order and still number its
   * versions by their first run.
   */
  async register(
    slug: string,
    version: string,
    graph: string,
    seenAt: Date,
    txEm?: EntityManager,
  ): Promise<void> {
    const now = Date.now();
    await (txEm ?? this.em.fork())
      .getKysely<WorkflowVersionDatabase>({ convertValues: false })
      .insertInto('workflow_versions')
      .values({
        slug,
        version,
        graph,
        first_seen_at: seenAt.getTime(),
        created_at: now,
        updated_at: now,
        deleted_at: null,
      })
      .onConflict((conflict) =>
        conflict.columns(['slug', 'version']).doUpdateSet((eb) => ({
          first_seen_at: eb.fn<number>('min', [
            eb.ref('workflow_versions.first_seen_at'),
            eb.ref('excluded.first_seen_at'),
          ]),
        })),
      )
      .execute();
  }

  /** Every version recorded for a workflow, oldest first. */
  async graphsOf(
    slug: string,
    txEm?: EntityManager,
  ): Promise<WorkflowVersionGraph[]> {
    const rows = await (txEm ?? this.em.fork())
      .getKysely<WorkflowVersionDatabase>({ convertValues: false })
      .selectFrom('workflow_versions')
      .select(['version', 'graph', 'first_seen_at'])
      .where('slug', '=', slug)
      .where('deleted_at', 'is', null)
      .orderBy('first_seen_at', 'asc')
      .orderBy('version', 'asc')
      .execute();
    return rows.map((row) => ({
      version: row.version,
      graph: row.graph,
      firstSeenAt: new Date(Number(row.first_seen_at)),
    }));
  }
}

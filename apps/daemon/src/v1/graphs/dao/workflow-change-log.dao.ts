import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { WorkflowChangeLogEntry } from '../entity/workflow-change-log-entry.entity';
import type { WorkflowChangeLogRecord } from '../graphs.types';

/**
 * `workflow_change_log` as SQLite stores it, with the table's own `rowid`;
 * dates are epoch milliseconds, since value conversion is off.
 */
interface ChangeLogDatabase {
  workflow_change_log: {
    rowid: number;
    id: string;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
    slug: WorkflowChangeLogEntry['slug'];
    changed_at: number;
    source: WorkflowChangeLogEntry['source'];
    from_version: WorkflowChangeLogEntry['fromVersion'];
    to_version: WorkflowChangeLogEntry['toVersion'];
    summary: WorkflowChangeLogEntry['summary'];
    reason: WorkflowChangeLogEntry['reason'];
    user_note: WorkflowChangeLogEntry['userNote'];
    recommendation_ids: WorkflowChangeLogEntry['recommendationIds'];
    chat_run_id: WorkflowChangeLogEntry['chatRunId'];
    card_seq: WorkflowChangeLogEntry['cardSeq'];
    backup: WorkflowChangeLogEntry['backup'];
  };
}

function idsOf(json: string | null): string[] {
  if (json === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}

/** The change log of the library's workflows (see the entity). */
@Injectable()
export class WorkflowChangeLogDao extends BaseDao<WorkflowChangeLogEntry> {
  constructor(em: EntityManager) {
    super(em, WorkflowChangeLogEntry);
  }

  /** Append one entry: a native insert, so no loaded entity is re-stamped by a flush. */
  async append(
    record: WorkflowChangeLogRecord,
    txEm?: EntityManager,
  ): Promise<void> {
    const { recommendationIds, ...fields } = record;
    await this.getRepo(txEm).insert(
      Object.assign(new WorkflowChangeLogEntry(), {
        ...fields,
        recommendationIds:
          recommendationIds.length === 0
            ? null
            : JSON.stringify(recommendationIds),
      }),
    );
  }

  /**
   * Every entry of one workflow, oldest first; entries written in the same
   * millisecond in the order they were written.
   */
  async entriesOf(
    slug: string,
    txEm?: EntityManager,
  ): Promise<WorkflowChangeLogRecord[]> {
    const rows = await (txEm ?? this.em.fork())
      .getKysely<ChangeLogDatabase>({ convertValues: false })
      .selectFrom('workflow_change_log')
      .selectAll()
      .where('slug', '=', slug)
      .where('deleted_at', 'is', null)
      .orderBy('changed_at', 'asc')
      .orderBy('rowid', 'asc')
      .execute();
    return rows.map((row) => ({
      slug: row.slug,
      changedAt: new Date(Number(row.changed_at)),
      source: row.source,
      fromVersion: row.from_version,
      toVersion: row.to_version,
      summary: row.summary,
      reason: row.reason,
      userNote: row.user_note,
      recommendationIds: idsOf(row.recommendation_ids),
      chatRunId: row.chat_run_id,
      cardSeq: row.card_seq,
      backup: row.backup,
    }));
  }
}

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { TeamChangeLogEntry } from '../entity/team-change-log-entry.entity';
import type { TeamChangeLogRecord } from '../teams.types';

/**
 * `team_change_log` as SQLite stores it, with the table's own `rowid`;
 * dates are epoch milliseconds, since value conversion is off.
 */
interface ChangeLogDatabase {
  team_change_log: {
    rowid: number;
    id: string;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
    slug: TeamChangeLogEntry['slug'];
    changed_at: number;
    source: TeamChangeLogEntry['source'];
    from_version: TeamChangeLogEntry['fromVersion'];
    to_version: TeamChangeLogEntry['toVersion'];
    summary: TeamChangeLogEntry['summary'];
    reason: TeamChangeLogEntry['reason'];
    user_note: TeamChangeLogEntry['userNote'];
    recommendation_ids: TeamChangeLogEntry['recommendationIds'];
    chat_run_id: TeamChangeLogEntry['chatRunId'];
    card_seq: TeamChangeLogEntry['cardSeq'];
    backup: TeamChangeLogEntry['backup'];
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

/** The change log of the library's teams (see the entity). */
@Injectable()
export class TeamChangeLogDao extends BaseDao<TeamChangeLogEntry> {
  constructor(em: EntityManager) {
    super(em, TeamChangeLogEntry);
  }

  /** Append one entry: a native insert, so no loaded entity is re-stamped by a flush. */
  async append(
    record: TeamChangeLogRecord,
    txEm?: EntityManager,
  ): Promise<void> {
    const { recommendationIds, ...fields } = record;
    await this.getRepo(txEm).insert(
      Object.assign(new TeamChangeLogEntry(), {
        ...fields,
        recommendationIds:
          recommendationIds.length === 0
            ? null
            : JSON.stringify(recommendationIds),
      }),
    );
  }

  /**
   * Every entry of one team, oldest first; entries written in the same
   * millisecond in the order they were written.
   */
  async entriesOf(
    slug: string,
    txEm?: EntityManager,
  ): Promise<TeamChangeLogRecord[]> {
    const rows = await (txEm ?? this.em.fork())
      .getKysely<ChangeLogDatabase>({ convertValues: false })
      .selectFrom('team_change_log')
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

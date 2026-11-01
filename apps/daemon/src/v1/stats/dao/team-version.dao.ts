import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { TeamVersion } from '../entity/team-version.entity';
import type { TeamVersionGraph } from '../stats.types';

/** `team_versions` as SQLite stores it; dates are epoch milliseconds, since value conversion is off. */
interface TeamVersionDatabase {
  team_versions: {
    slug: TeamVersion['slug'];
    version: TeamVersion['version'];
    graph: TeamVersion['graph'];
    first_seen_at: number;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
  };
}

/** The registry of definitions each team has run with (see the entity). */
@Injectable()
export class TeamVersionDao extends BaseDao<TeamVersion> {
  constructor(em: EntityManager) {
    super(em, TeamVersion);
  }

  /**
   * Record a version's team the first time a run of it is seen. A version
   * already recorded keeps its team and moves `firstSeenAt` only earlier, so
   * the boot sweep may meet a team's runs in any order and still number its
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
      .getKysely<TeamVersionDatabase>({ convertValues: false })
      .insertInto('team_versions')
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
            eb.ref('team_versions.first_seen_at'),
            eb.ref('excluded.first_seen_at'),
          ]),
        })),
      )
      .execute();
  }

  /** Every version recorded for a team, oldest first. */
  async graphsOf(
    slug: string,
    txEm?: EntityManager,
  ): Promise<TeamVersionGraph[]> {
    const rows = await (txEm ?? this.em.fork())
      .getKysely<TeamVersionDatabase>({ convertValues: false })
      .selectFrom('team_versions')
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

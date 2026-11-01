import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { ConflictException } from '@packages/common';

import { RunDao } from '../../agents/dao/run.dao';
import { assertTeamRun } from '../../agents/utils/run-kind';
import type { Run } from '../../runs/entity/run.entity';
import type { RunTeamSnapshotWire, Team } from '../teams.types';
import { parseTeamSnapshot, teamSnapshotOf } from '../utils/team-snapshot';
import { TeamStoreService } from './team-store.service';

/**
 * The ONE answer to "which graph does this existing run run" — its snapshot,
 * never the library's current copy.
 *
 * Asked for as "old teams chats should not be changed if i change current
 * team. They should use snapshots". Every reader of an existing run's graph
 * goes through here — a follow-up pass, the agents panel, the terminal handoff,
 * a task's settle — because each one that read the library on its own was a
 * place an edit reached a run it must not.
 *
 * A run made before runs kept a copy is FROZEN on its first read: the library
 * copy as it is at that moment is written onto the run and used from then on.
 * Chosen over refusing such a run (a live run could not be continued) and over
 * reading the library for it forever (the defect, kept for every run that
 * already exists).
 *
 * Only an EMPTY column is frozen. A copy this build cannot read is refused
 * with `TEAM_SNAPSHOT_UNREADABLE` rather than re-frozen: it is still the
 * graph the run started with, and overwriting it with today's library copy
 * would run a different graph under the old run's name — and destroy the only
 * record of the original while doing it.
 */
@Injectable()
export class RunTeamService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly store: TeamStoreService,
  ) {}

  /**
   * The graph a team run runs. The run object passed in is updated too
   * when this freezes it, so a caller holding it sees the same copy.
   */
  async teamOf(
    run: Pick<Run, 'id' | 'teamSnapshot'> & { teamId: string },
    em?: EntityManager,
  ): Promise<Team> {
    const kept = parseTeamSnapshot(run.teamSnapshot);
    if (kept.state === 'readable') {
      return kept.team;
    }
    if (kept.state === 'unreadable') {
      throw new ConflictException(
        'TEAM_SNAPSHOT_UNREADABLE',
        `The copy of the team run ${run.id} started with cannot be read by this version (${kept.reason}). It is left as it is rather than replaced by the library's current '${run.teamId}', which may not be the graph this run ran.`,
      );
    }
    const { team } = await this.store.get(run.teamId);
    const snapshot = teamSnapshotOf(team);
    // Freezing a copy on first READ is not activity in the run — see
    // `RunDao.updateWithoutActivity`.
    await this.runDao.updateWithoutActivity(
      run.id,
      { teamSnapshot: snapshot },
      em,
    );
    run.teamSnapshot = snapshot;
    return team;
  }

  /** The wire answer for `GET /v1/teams/runs/:runId/team`. */
  async snapshotOfRun(runId: string): Promise<RunTeamSnapshotWire> {
    const em = this.em.fork();
    const run = assertTeamRun(await this.runDao.getById(runId, em), runId);
    return { team: await this.teamOf(run, em) };
  }
}

import type { FilterQuery } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { idBatches } from '../../agents/utils/id-batches';
import { LessonProposal } from '../entity/lesson-proposal.entity';
import type { LessonProposalStatus } from '../lessons.types';

const KEPT_OUT: readonly LessonProposalStatus[] = [
  'rejected',
  'undone',
  'dropped_by_check',
];

@Injectable()
export class LessonProposalDao extends BaseDao<LessonProposal> {
  constructor(em: EntityManager) {
    super(em, LessonProposal);
  }

  /** Proposals newest first, narrowed by status and source thread. */
  list(
    filter: {
      statuses?: readonly LessonProposalStatus[];
      sourceRunId?: string;
    },
    txEm?: EntityManager,
  ): Promise<LessonProposal[]> {
    const where: FilterQuery<LessonProposal> = {};
    if (filter.statuses !== undefined) {
      where.status = { $in: [...filter.statuses] };
    }
    if (filter.sourceRunId !== undefined) {
      where.sourceRunId = filter.sourceRunId;
    }
    return this.getRepo(txEm).find(where, {
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      disableIdentityMap: true,
    });
  }

  /** How many lessons were saved to memory since a moment, by the user or on their own. */
  savedSince(since: Date, txEm?: EntityManager): Promise<number> {
    return this.getRepo(txEm).count({
      status: 'saved',
      decidedAt: { $gte: since },
    });
  }

  /**
   * How many lessons a second-model check dropped, per run: under the
   * reflection that proposed them and under the check that dropped them.
   */
  async droppedByCheckOf(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const add = (runId: string | null): void => {
      if (runId !== null) {
        counts.set(runId, (counts.get(runId) ?? 0) + 1);
      }
    };
    for (const batch of idBatches(runIds)) {
      const rows = await this.getRepo(txEm).find(
        {
          status: 'dropped_by_check',
          $or: [
            { reflectionRunId: { $in: batch } },
            { checkRunId: { $in: batch } },
          ],
        },
        {
          fields: ['reflectionRunId', 'checkRunId'],
          disableIdentityMap: true,
        },
      );
      const wanted = new Set(batch);
      for (const row of rows) {
        add(wanted.has(row.reflectionRunId) ? row.reflectionRunId : null);
        add(
          row.checkRunId !== null && wanted.has(row.checkRunId)
            ? row.checkRunId
            : null,
        );
      }
    }
    return counts;
  }

  /** Every proposal filed on these segments, read in windows of segment ids. */
  async ofSegments(
    segmentIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<LessonProposal[]> {
    const rows: LessonProposal[] = [];
    for (const batch of idBatches(segmentIds)) {
      rows.push(
        ...(await this.getRepo(txEm).find(
          { segmentId: { $in: batch } },
          { disableIdentityMap: true },
        )),
      );
    }
    return rows;
  }

  /** The proposals one reflection filed, in the order it filed them. */
  ofReflection(
    reflectionRunId: string,
    txEm?: EntityManager,
  ): Promise<LessonProposal[]> {
    return this.getRepo(txEm).find(
      { reflectionRunId },
      { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    );
  }

  /**
   * The newest proposals kept out of memory in one place — rejected or undone
   * by the user, or dropped by the check: the same team for a team run, else
   * the same project, else those of no project and no team.
   */
  rejectedIn(
    place: { projectId: string | null; teamSlug: string | null },
    limit: number,
    txEm?: EntityManager,
  ): Promise<LessonProposal[]> {
    const where: FilterQuery<LessonProposal> =
      place.teamSlug !== null
        ? { status: { $in: [...KEPT_OUT] }, teamSlug: place.teamSlug }
        : {
            status: { $in: [...KEPT_OUT] },
            projectId: place.projectId,
            teamSlug: null,
          };
    return this.getRepo(txEm).find(where, {
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      limit,
      disableIdentityMap: true,
    });
  }
}

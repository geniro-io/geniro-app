import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { ReviewComment } from '../../runs/entity/review-comment.entity';

/** `review_comments` — the review screen's comments, one row each, gone with their run. */
@Injectable()
export class ReviewCommentDao extends BaseDao<ReviewComment> {
  constructor(em: EntityManager) {
    super(em, ReviewComment);
  }

  async listByRun(
    runId: string,
    txEm?: EntityManager,
  ): Promise<ReviewComment[]> {
    return this.getRepo(txEm).find({ runId }, { orderBy: { number: 'asc' } });
  }

  /** The run's highest number, deleted comments included, so a number is never handed out twice. */
  async highestNumber(runId: string, txEm?: EntityManager): Promise<number> {
    const row = await (txEm ?? this.em.fork())
      .getKysely<{ review_comments: { run_id: string; number: number } }>({
        convertValues: false,
      })
      .selectFrom('review_comments')
      .select((eb) => eb.fn.max<number | null>('number').as('number'))
      .where('run_id', '=', runId)
      .executeTakeFirst();
    return row?.number ?? 0;
  }
}

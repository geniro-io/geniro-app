import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { KnowledgeRevision } from '../entity/knowledge-revision.entity';
import type {
  KnowledgeRevisionStatus,
  KnowledgeTextDatabase,
} from '../knowledge.types';

@Injectable()
export class KnowledgeRevisionDao extends BaseDao<KnowledgeRevision> {
  constructor(em: EntityManager) {
    super(em, KnowledgeRevision);
  }

  /** How many revisions wait on review, per document that has any. */
  async pendingCounts(
    documentIds: readonly string[] | null,
    em: EntityManager = this.em,
  ): Promise<Map<string, number>> {
    let query = this.database(em)
      .selectFrom('knowledge_revisions')
      .select('document_id')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('status', '=', 'pending')
      .groupBy('document_id');
    if (documentIds !== null) {
      if (documentIds.length === 0) {
        return new Map();
      }
      query = query.where('document_id', 'in', [...documentIds]);
    }
    const rows = await query.execute();
    return new Map(rows.map((row) => [row.document_id, Number(row.count)]));
  }

  /** Newest first; bodies are left for the one revision opened. */
  async heads(
    documentId: string,
    em: EntityManager = this.em,
  ): Promise<KnowledgeRevision[]> {
    return em.find(
      KnowledgeRevision,
      { documentId },
      {
        orderBy: { createdAt: 'desc', id: 'desc' },
        exclude: ['body'],
      },
    ) as Promise<KnowledgeRevision[]>;
  }

  /** The applied revision at `rev`, whole, when it is still kept. */
  async appliedAt(
    documentId: string,
    rev: number,
    em: EntityManager = this.em,
  ): Promise<KnowledgeRevision | null> {
    return em.findOne(KnowledgeRevision, {
      documentId,
      rev,
      status: 'applied',
    });
  }

  /** Drop decided revisions past the newest `keep`; pending ones always stay. */
  async trim(
    documentId: string,
    keep: number,
    em: EntityManager,
  ): Promise<void> {
    const decided: KnowledgeRevisionStatus[] = ['applied', 'rejected'];
    const rows = await this.database(em)
      .selectFrom('knowledge_revisions')
      .select('id')
      .where('document_id', '=', documentId)
      .where('status', 'in', decided)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .offset(keep)
      .limit(1000)
      .execute();
    await this.deleteIds(
      rows.map((row) => row.id),
      em,
    );
  }

  async deleteForDocuments(
    documentIds: readonly string[],
    em: EntityManager,
  ): Promise<void> {
    if (documentIds.length === 0) {
      return;
    }
    await this.database(em)
      .deleteFrom('knowledge_revisions')
      .where('document_id', 'in', [...documentIds])
      .execute();
  }

  private async deleteIds(
    ids: readonly string[],
    em: EntityManager,
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.database(em)
      .deleteFrom('knowledge_revisions')
      .where('id', 'in', [...ids])
      .execute();
  }

  private database(em: EntityManager) {
    return em.getKysely<KnowledgeTextDatabase>({ convertValues: false });
  }
}

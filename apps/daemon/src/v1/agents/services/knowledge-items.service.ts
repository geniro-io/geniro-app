import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import type {
  KnowledgeActor,
  KnowledgeItemOutcome,
} from '../../knowledge/knowledge.types';
import { KnowledgeService } from '../../knowledge/services/knowledge.service';
import type { AnalysisTurn } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import {
  appliedMarksOf,
  appliesOf,
  knowledgeWriteOf,
  readCard,
  unappliedRefusal,
} from '../utils/recommendations-card';

/** What carrying out a `K-` item came to, or why it was not carried out. */
export type KnowledgeItemAnswer =
  KnowledgeItemOutcome | { kind: 'item-refused'; code: string; reason: string };

function refused(code: string, reason: string): KnowledgeItemAnswer {
  return { kind: 'item-refused', code, reason };
}

/**
 * Writes a knowledge item the user applied from a recommendations card. The text
 * is the card's, never the model's, and the write counts as the user's review:
 * they read it there and pressed Apply.
 */
@Injectable()
export class KnowledgeItemsService {
  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    private readonly knowledge: KnowledgeService,
  ) {}

  async carryOut(
    turn: AnalysisTurn,
    actor: KnowledgeActor,
    id: string,
  ): Promise<KnowledgeItemAnswer> {
    const em = this.em.fork();
    const apply = (await appliesOf(this.itemDao, turn.analysisRunId, em)).at(
      -1,
    );
    if (apply === undefined) {
      return refused(
        'NOT_APPLIED',
        'nothing has been applied in this chat yet — a knowledge item is written only once the user applied it',
      );
    }
    const refusal = unappliedRefusal('knowledge', [id], apply);
    if (refusal !== null) {
      return refused(refusal.error, refusal.message);
    }
    let write;
    let moveSource: string | undefined;
    try {
      const card = await readCard(
        this.itemDao,
        turn.analysisRunId,
        apply.cardSeq,
        em,
      );
      const item = card.items.find((entry) => entry.id === id);
      write = item === undefined ? null : knowledgeWriteOf(item);
      moveSource = item?.movesWith;
    } catch {
      return refused(
        'CARD_GONE',
        'the recommendations card the Apply named cannot be read',
      );
    }
    if (write === null) {
      return refused('NOT_A_KNOWLEDGE_ITEM', `${id} names no document`);
    }
    if (write.kind === 'retire' && moveSource !== undefined) {
      const applied = await appliedMarksOf(
        this.itemDao,
        turn.analysisRunId,
        apply.cardSeq,
        em,
      );
      if (!applied.has(moveSource)) {
        return refused(
          'MOVE_SOURCE_FIRST',
          `${id} retires a document whose text moves to ${moveSource}: carry that out and mark it applied first, so the text is never in neither place`,
        );
      }
    }
    return this.knowledge.applyRecommended(actor, write);
  }
}

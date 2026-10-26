import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import {
  HOST_RECOMMENDATION_MARKS_TOOL,
  type ItemWire,
  type RecommendationItem,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { appliesOf, readCard } from '../utils/recommendations-card';
import { ChatService } from './chat.service';

/** What the card's Apply sends — see `ApplyRecommendationsDto`. */
export interface ApplyRecommendations {
  cardSeq: number;
  ids: string[];
  note?: string;
  clientMessageId: string;
}

/**
 * The card's Apply: composes the user message that tells the analysis agent
 * exactly which items to apply, and sends it with the selection persisted on
 * the message row (`payload.apply`) — the record `save_workflow_change` checks
 * every write against, so an item nobody selected cannot be saved.
 *
 * The message carries every selected item in FULL rather than naming ids, so
 * it does not depend on the resumed session still holding the analysis.
 */
@Injectable()
export class RecommendationsApplyService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly chats: ChatService,
  ) {}

  async apply(runId: string, input: ApplyRecommendations): Promise<ItemWire> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (run === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${runId}`);
    }
    if (run.analysisSourceRunId === null) {
      throw new ConflictException(
        'NOT_AN_ANALYSIS',
        'recommendations are applied only in an analysis chat',
      );
    }
    const card = await readCard(this.itemDao, runId, input.cardSeq, em);
    // One Apply per card: the newest Apply is what `save_workflow_change`
    // may write, so a second press from a window that cannot see the first
    // would silently re-open the selection.
    const applies = await appliesOf(this.itemDao, runId, em);
    if (applies.some((apply) => apply.cardSeq === input.cardSeq)) {
      throw new ConflictException(
        'ALREADY_APPLIED',
        `the card at seq ${input.cardSeq} has already been applied`,
      );
    }
    const byId = new Map(card.items.map((item) => [item.id, item]));
    const unknown = input.ids.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      throw new BadRequestException(
        'UNKNOWN_RECOMMENDATION',
        `the card has no ${unknown.join(', ')}`,
      );
    }
    const ids = [...new Set(input.ids)];
    return this.chats.sendMessage(
      runId,
      composeApplyMessage(
        input.cardSeq,
        ids.map((id) => byId.get(id)!),
        card.items.filter((item) => !ids.includes(item.id)),
        input.note,
      ),
      [],
      {
        clientMessageId: input.clientMessageId,
        apply: { cardSeq: input.cardSeq, ids },
      },
    );
  }
}

/** The Apply message: every selected item in full, then what to leave alone. */
export function composeApplyMessage(
  cardSeq: number,
  selected: readonly RecommendationItem[],
  unselected: readonly RecommendationItem[],
  note: string | undefined,
): string {
  const blocks = selected.map((item) =>
    [
      `### ${item.id} · ${item.title}`,
      `Target: ${item.target} · ${item.territory} · ${item.kind} · ${item.location}`,
      'Change:',
      item.change,
    ].join('\n'),
  );
  const lines = [
    `Apply these recommendations from the card at seq ${cardSeq} — exactly these, nothing else:`,
    '',
    blocks.join('\n\n'),
  ];
  if (unselected.length > 0) {
    lines.push(
      '',
      `Not selected — leave alone: ${unselected.map((item) => item.id).join(', ')}.`,
    );
  }
  const trimmed = note?.trim() ?? '';
  if (trimmed !== '') {
    lines.push('', `Note from the user: ${trimmed}`);
  }
  lines.push(
    '',
    `When done, call ${HOST_RECOMMENDATION_MARKS_TOOL} with cardSeq ${cardSeq} and an outcome for each of: ${selected.map((item) => item.id).join(', ')}.`,
  );
  return lines.join('\n');
}

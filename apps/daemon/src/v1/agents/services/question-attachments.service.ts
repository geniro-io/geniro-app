import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import { ItemDao } from '../dao/item.dao';
import { parseJsonColumn } from '../utils/json-util';
import {
  NO_QUESTION_ATTACHMENTS,
  type QuestionAttachmentFields,
  questionAttachmentsOf,
  questionCardText,
} from '../utils/question-attachments';
import { ChatArtifactsService } from './chat-artifacts.service';

export interface QuestionCardAsk {
  runId: string;
  title: string | null;
  /** The card's `questions` payload, as written on the row. */
  questions: unknown;
  /** Page ids the asking agent passed with `ask_user_question`'s `artifacts`. */
  explicit?: readonly string[];
  /** The member call the card is raised inside; its turn starts at the call. */
  callId?: string;
}

/**
 * Gathers what {@link questionAttachmentsOf} folds for one question card: the
 * run's pages, its picture sets and its asking turn's visual rows. A read that
 * fails attaches nothing; it never refuses the question.
 */
@Injectable()
export class QuestionAttachmentsService {
  private readonly logger = new Logger(QuestionAttachmentsService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    private readonly artifacts: ChatArtifactsService,
  ) {}

  /**
   * What a card's row spreads in: its attachments when it asks the user
   * `questions`, nothing for any other card.
   */
  async cardFields(
    runId: string,
    title: string | null,
    questions: unknown,
    explicit: readonly string[] = [],
    callId?: string,
  ): Promise<QuestionAttachmentFields | Record<string, never>> {
    if (!Array.isArray(questions) || questions.length === 0) {
      return {};
    }
    return this.fieldsFor({ runId, title, questions, explicit, callId });
  }

  async fieldsFor(ask: QuestionCardAsk): Promise<QuestionAttachmentFields> {
    try {
      const em = this.em.fork();
      const [listing, galleries, turnStart] = await Promise.all([
        this.artifacts.read(ask.runId),
        this.itemDao.rowsOfKinds(ask.runId, ['show_gallery'], undefined, em),
        this.turnStartOf(ask.runId, ask.callId, em),
      ]);
      const turnRows = await this.itemDao.rowsOfKindsBetween(
        ask.runId,
        ['show_artifact', 'show_gallery'],
        turnStart,
        Number.MAX_SAFE_INTEGER,
        em,
      );
      return questionAttachmentsOf({
        explicit: ask.explicit ?? [],
        text: questionCardText(ask.title, ask.questions),
        pages: listing.artifacts,
        galleries: galleries.map((row) => ({
          seq: row.seq,
          payload: payloadOf(row.payload),
        })),
        turn: turnRows.flatMap(
          (row): ({ gallerySeq: number } | { artifactId: string })[] => {
            if (row.kind === 'show_gallery') {
              return [{ gallerySeq: row.seq }];
            }
            const artifactId = payloadOf(row.payload).artifactId;
            return typeof artifactId === 'string' ? [{ artifactId }] : [];
          },
        ),
      });
    } catch (err) {
      this.logger.warn(
        `run ${ask.runId}: a question's pages could not be read — attached none: ${err instanceof Error ? err.message : String(err)}`,
      );
      return NO_QUESTION_ATTACHMENTS;
    }
  }

  /** The ids among `ids` that name no page of the run, and the ids it did publish. */
  async unknownPages(
    runId: string,
    ids: readonly string[],
  ): Promise<{ unknown: string[]; published: string[] }> {
    let published: string[];
    try {
      published = (await this.artifacts.read(runId)).artifacts.map(
        (page) => page.artifactId,
      );
    } catch (err) {
      this.logger.warn(
        `run ${runId}: its pages could not be read — the question's page ids go unchecked: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { unknown: [], published: [] };
    }
    return {
      unknown: ids.filter((id) => !published.includes(id)),
      published,
    };
  }

  private async turnStartOf(
    runId: string,
    callId: string | undefined,
    em: EntityManager,
  ): Promise<number> {
    if (callId !== undefined) {
      const started = (await this.itemDao.callRowsOf(runId, [callId], em)).find(
        (row) => row.kind === 'call_started',
      );
      if (started !== undefined) {
        return started.seq;
      }
    }
    return (await this.itemDao.latestUserMessage(runId, em))?.seq ?? 0;
  }
}

function payloadOf(value: unknown): Record<string, unknown> {
  const parsed: unknown =
    typeof value === 'string' ? parseJsonColumn(value) : value;
  return typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>)
    : {};
}

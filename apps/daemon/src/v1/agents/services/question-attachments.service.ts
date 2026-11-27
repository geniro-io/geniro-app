import { Injectable, Logger } from '@nestjs/common';

import {
  NO_QUESTION_ATTACHMENTS,
  type QuestionAttachmentFields,
  questionAttachmentsOf,
} from '../utils/question-attachments';
import { ChatArtifactsService } from './chat-artifacts.service';

/**
 * Resolves the pages a question card carries: only the ones its asking agent
 * passed with `ask_user_question`'s `artifacts`, read against the run's own
 * listing. A read that fails attaches nothing; it never refuses the question.
 */
@Injectable()
export class QuestionAttachmentsService {
  private readonly logger = new Logger(QuestionAttachmentsService.name);

  constructor(private readonly artifacts: ChatArtifactsService) {}

  /**
   * What a card's row spreads in: its attachments when it asks the user
   * `questions`, nothing for any other card.
   */
  async cardFields(
    runId: string,
    questions: unknown,
    explicit: readonly string[] = [],
  ): Promise<QuestionAttachmentFields | Record<string, never>> {
    if (!Array.isArray(questions) || questions.length === 0) {
      return {};
    }
    if (explicit.length === 0) {
      return { ...NO_QUESTION_ATTACHMENTS, attachments: [] };
    }
    try {
      return questionAttachmentsOf(
        explicit,
        (await this.artifacts.read(runId)).artifacts,
      );
    } catch (err) {
      this.logger.warn(
        `run ${runId}: a question's pages could not be read — attached none: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { ...NO_QUESTION_ATTACHMENTS, attachments: [] };
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
}

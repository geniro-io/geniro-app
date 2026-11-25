import { Injectable } from '@nestjs/common';

import type { ReviewSendWire } from '../../agents/chat.types';
import { ReviewCommentsService } from '../../agents/services/review-comments.service';
import { TeamExecutorService } from './team-executor.service';

/**
 * The review screen's send in a TEAM run: the chat's send, delivered to the
 * run's lead the way a typed message is, but only into a turn of its own —
 * `RUN_BUSY` while a lead's turn runs, as the chat's send. Here rather than in
 * `v1/agents`, because only this side can reach the executor.
 */
@Injectable()
export class TeamReviewService {
  constructor(
    private readonly reviews: ReviewCommentsService,
    private readonly executor: TeamExecutorService,
  ) {}

  send(
    runId: string,
    input: { clientMessageId: string; note: string | null },
  ): Promise<ReviewSendWire> {
    return this.reviews.send(runId, input, (message) =>
      this.executor.sendMessage(
        runId,
        message.text,
        [],
        message.clientMessageId,
        undefined,
        message.storedText,
        { payload: message.review, ownTurn: true },
      ),
    );
  }
}

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import { ReviewComment } from '../../runs/entity/review-comment.entity';
import {
  type ItemWire,
  REVIEW_COMMENT_MAX_CHARS,
  REVIEW_MAX_COMMENTS,
  type ReviewAgentStatus,
  type ReviewCommentDraft,
  type ReviewCommentRefusalCode,
  type ReviewCommentsOutcome,
  type ReviewCommentWire,
  type ReviewMessage,
  type ReviewSendWire,
  SINGLE_AGENT_NODE,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { ReviewCommentDao } from '../dao/review-comment.dao';
import { RunDao } from '../dao/run.dao';
import { withoutHiddenText } from '../utils/hidden-text';
import { itemToWire } from '../utils/item-wire';
import { KeyedChain } from '../utils/keyed-chain';
import { composeReviewText, snapshotOf } from '../utils/review-message';
import { AgentEventBus } from './agent-events.bus';

export type ReviewDelivery = (message: ReviewMessage) => Promise<ItemWire>;

interface Refusal {
  code: ReviewCommentRefusalCode;
  reason: string;
}

interface WritableRun {
  id: string;
  archivedAt: Date | null;
}

/**
 * The review screen's comments on a thread's changes: the user's drafts, the
 * one message a review sends, and the agent's answer to each comment.
 */
@Injectable()
export class ReviewCommentsService implements OnModuleInit {
  private readonly writes = new KeyedChain();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly comments: ReviewCommentDao,
    private readonly bus: AgentEventBus,
    private readonly items: ItemDao,
  ) {}

  onModuleInit(): void {
    this.bus.allDeleted().subscribe((runId) => {
      this.writes.forget(runId);
    });
  }

  async list(runId: string): Promise<ReviewCommentWire[] | null> {
    const em = this.em.fork();
    if ((await this.runDao.getById(runId, em)) === null) {
      return null;
    }
    return (await this.comments.listByRun(runId, em)).map(toWire);
  }

  add(
    runId: string,
    draft: ReviewCommentDraft,
  ): Promise<ReviewCommentsOutcome> {
    return this.write(runId, async (_comments, em) => {
      const body = draft.body.trim();
      const problem =
        textProblem(body, 'comment') ??
        (draft.quote.length > REVIEW_COMMENT_MAX_CHARS
          ? tooLong('quoted code')
          : null) ??
        rangeProblem(draft);
      if (problem !== null) {
        return problem;
      }
      const lineless = draft.side === 'file';
      const startLine = lineless ? null : (draft.startLine ?? null);
      const comment = em.create(
        ReviewComment,
        {
          runId,
          number: (await this.comments.highestNumber(runId, em)) + 1,
          folder: draft.folder,
          path: draft.path,
          side: draft.side,
          startLine,
          endLine: lineless ? null : (draft.endLine ?? startLine),
          quote: lineless ? '' : withoutHiddenText(draft.quote, true),
          body,
          status: 'draft',
        },
        { partial: true },
      );
      em.persist(comment);
      await em.flush();
      return [comment];
    });
  }

  edit(
    runId: string,
    commentId: string,
    body: string,
  ): Promise<ReviewCommentsOutcome> {
    return this.write(runId, async (comments, em) => {
      const comment = comments.find((each) => each.id === commentId);
      if (comment === undefined) {
        return notFound();
      }
      if (comment.status !== 'draft') {
        return refuse(
          'REVIEW_COMMENT_NOT_DRAFT',
          'this comment was already sent — write a new one for the next review',
        );
      }
      const text = body.trim();
      const problem = textProblem(text, 'comment');
      if (problem !== null) {
        return problem;
      }
      comment.body = text;
      await em.flush();
      return [comment];
    });
  }

  setStatus(
    runId: string,
    commentId: string,
    status: 'resolved' | 'sent',
  ): Promise<ReviewCommentsOutcome> {
    return this.write(runId, async (comments, em) => {
      const comment = comments.find((each) => each.id === commentId);
      if (comment === undefined) {
        return notFound();
      }
      if (comment.status === 'draft') {
        return refuse(
          'REVIEW_COMMENT_NOT_SENT',
          'a draft is resolved by deleting it',
        );
      }
      comment.status = status;
      if (status === 'sent') {
        comment.agentStatus = null;
      }
      await em.flush();
      return [comment];
    });
  }

  remove(runId: string, commentId: string): Promise<ReviewCommentsOutcome> {
    return this.write(runId, async (comments, em) => {
      const comment = comments.find((each) => each.id === commentId);
      if (comment === undefined) {
        return notFound();
      }
      comment.deletedAt = new Date();
      await em.flush();
      return [];
    });
  }

  /** The agent's answer to one sent comment, through `answer_review_comment`. */
  answer(
    runId: string,
    actor: { memberId: string | null },
    input: { comment: number; reply: string; status: ReviewAgentStatus },
  ): Promise<ReviewCommentsOutcome> {
    return this.write(runId, async (comments, em) => {
      const comment = comments.find((each) => each.number === input.comment);
      if (comment === undefined) {
        return refuse(
          'REVIEW_COMMENT_NOT_FOUND',
          `this run has no review comment #${input.comment}`,
        );
      }
      if (comment.status !== 'sent') {
        return refuse(
          'REVIEW_COMMENT_NOT_SENT',
          comment.status === 'draft'
            ? `#${input.comment} is still a draft the user has not sent`
            : `#${input.comment} is already resolved by the user`,
        );
      }
      const reply = input.reply.trim();
      const problem = textProblem(reply, 'reply');
      if (problem !== null) {
        return problem;
      }
      comment.agentReply = reply;
      comment.agentStatus = input.status;
      comment.agentRepliedAt = new Date();
      comment.agentMemberId =
        actor.memberId === SINGLE_AGENT_NODE ? null : actor.memberId;
      await em.flush();
      return [comment];
    });
  }

  /**
   * Every draft as ONE message to the run's agent. Drafts become sent only once
   * `deliver` accepted the message; a refusal (`RUN_BUSY`) leaves them drafts,
   * and a retry with the same `clientMessageId` replays the stored row.
   */
  send(
    runId: string,
    input: { clientMessageId: string; note: string | null },
    deliver: ReviewDelivery,
  ): Promise<ReviewSendWire> {
    return this.writes.run(runId, async () => {
      const em = this.em.fork();
      const run = await this.runDao.getById(runId, em);
      if (run === null) {
        throw new NotFoundException('RUN_NOT_FOUND', `no run ${runId}`);
      }
      if (run.archivedAt !== null) {
        throw new ConflictException(
          'RUN_ARCHIVED',
          'this chat is archived — unarchive it to send a review',
        );
      }
      const comments = await this.comments.listByRun(runId, em);
      const stored = await this.items.userMessageByClientId(
        runId,
        input.clientMessageId,
      );
      if (stored !== null) {
        const replayed = itemToWire(stored);
        const numbers = reviewNumbersOf(replayed.payload);
        await this.markSent(
          em,
          comments.filter(
            (comment) =>
              comment.status === 'draft' && numbers.includes(comment.number),
          ),
          replayed.seq,
        );
        this.bus.publishReviewCommentsChanged(runId);
        return { seq: replayed.seq, sent: numbers.length };
      }
      const drafts = comments.filter((comment) => comment.status === 'draft');
      if (drafts.length === 0) {
        throw new BadRequestException(
          'REVIEW_EMPTY',
          'there are no draft comments to send',
        );
      }
      if (drafts.length > REVIEW_MAX_COMMENTS) {
        throw new BadRequestException(
          'REVIEW_TOO_LARGE',
          `a review carries at most ${REVIEW_MAX_COMMENTS} comments — delete some drafts or send them in two reviews`,
        );
      }
      const note = input.note?.trim() || null;
      const snapshots = drafts.map(snapshotOf);
      const text = composeReviewText(note, snapshots, run.cwd ?? '');
      const item = await deliver({
        text,
        storedText: text,
        review: { note, comments: snapshots },
        clientMessageId: input.clientMessageId,
      });
      await this.markSent(em, drafts, item.seq);
      this.bus.publishReviewCommentsChanged(runId);
      return { seq: item.seq, sent: drafts.length };
    });
  }

  private async markSent(
    em: EntityManager,
    drafts: readonly ReviewComment[],
    seq: number,
  ): Promise<void> {
    if (drafts.length === 0) {
      return;
    }
    const sentAt = new Date();
    for (const draft of drafts) {
      draft.status = 'sent';
      draft.sentSeq = seq;
      draft.sentAt = sentAt;
    }
    await em.flush();
  }

  private write(
    runId: string,
    change: (
      comments: ReviewComment[],
      em: EntityManager,
      run: WritableRun,
    ) => Promise<ReviewComment[] | Refusal>,
  ): Promise<ReviewCommentsOutcome> {
    return this.writes.run(runId, async () => {
      const em = this.em.fork();
      const run = await this.runDao.getById(runId, em);
      if (run === null) {
        return { status: 'refused', ...missingRun() };
      }
      if (run.archivedAt !== null) {
        return {
          status: 'refused',
          code: 'RUN_ARCHIVED',
          reason: 'this chat is archived — unarchive it to change its review',
        };
      }
      const changed = await change(
        await this.comments.listByRun(runId, em),
        em,
        run,
      );
      if ('code' in changed) {
        return { status: 'refused', ...changed };
      }
      const comments = (await this.comments.listByRun(runId, em)).map(toWire);
      this.bus.publishReviewCommentsChanged(runId);
      return { status: 'ok', comments, changed: changed.map(toWire) };
    });
  }
}

function toWire(comment: ReviewComment): ReviewCommentWire {
  return {
    id: comment.id,
    number: comment.number,
    folder: comment.folder,
    path: comment.path,
    side: comment.side,
    startLine: comment.startLine,
    endLine: comment.endLine,
    quote: comment.quote,
    body: comment.body,
    status: comment.status,
    sentSeq: comment.sentSeq,
    sentAt: comment.sentAt?.toISOString() ?? null,
    agentStatus: comment.agentStatus,
    agentReply: comment.agentReply,
    agentRepliedAt: comment.agentRepliedAt?.toISOString() ?? null,
    agentMemberId: comment.agentMemberId,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
  };
}

function reviewNumbersOf(payload: unknown): number[] {
  const review =
    typeof payload === 'object' && payload !== null && 'review' in payload
      ? payload.review
      : null;
  const comments =
    typeof review === 'object' && review !== null && 'comments' in review
      ? review.comments
      : null;
  if (!Array.isArray(comments)) {
    return [];
  }
  return comments.flatMap((comment: unknown) =>
    typeof comment === 'object' &&
    comment !== null &&
    'number' in comment &&
    typeof comment.number === 'number'
      ? [comment.number]
      : [],
  );
}

function textProblem(text: string, what: string): Refusal | null {
  if (text === '') {
    return refuse('REVIEW_COMMENT_EMPTY', `the ${what} is empty`);
  }
  return text.length > REVIEW_COMMENT_MAX_CHARS ? tooLong(`the ${what}`) : null;
}

function tooLong(what: string): Refusal {
  return refuse(
    'REVIEW_COMMENT_TOO_LONG',
    `${what} is over ${REVIEW_COMMENT_MAX_CHARS} characters`,
  );
}

function rangeProblem(draft: ReviewCommentDraft): Refusal | null {
  if (draft.side === 'file') {
    return null;
  }
  const start = draft.startLine ?? null;
  const end = draft.endLine ?? start;
  return start === null || start < 1 || end === null || end < start
    ? refuse(
        'REVIEW_COMMENT_BAD_RANGE',
        'a line comment needs a first line of at least 1 and a last line not before it',
      )
    : null;
}

function refuse(code: ReviewCommentRefusalCode, reason: string): Refusal {
  return { code, reason };
}

function notFound(): Refusal {
  return refuse(
    'REVIEW_COMMENT_NOT_FOUND',
    'this review comment no longer exists',
  );
}

function missingRun(): Refusal {
  return refuse('RUN_NOT_FOUND', 'this run no longer exists');
}

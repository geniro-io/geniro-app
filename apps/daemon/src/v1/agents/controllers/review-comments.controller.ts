import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { NotFoundException } from '@packages/common';
import { ZodResponse } from 'nestjs-zod';

import type { ReviewCommentsWire, ReviewSendWire } from '../chat.types';
import {
  CreateReviewCommentDto,
  EditReviewCommentDto,
  ReviewCommentsDto,
  ReviewSendDto,
  SendReviewDto,
} from '../dto/chat.dto';
import { ChatService } from '../services/chat.service';
import { ReviewCommentsService } from '../services/review-comments.service';
import { reviewCommentsOrThrow } from '../utils/review-comments-outcome';

/**
 * The review screen's comments on a thread's changes, and the chat's send of
 * them as one review. Open to paired devices, like the rest of a chat; a team
 * run's send is `TeamsController`'s twin route.
 */
@Controller('v1/chats/:runId/review-comments')
@ApiTags('chats')
@ApiBearerAuth()
export class ReviewCommentsController {
  constructor(
    private readonly reviews: ReviewCommentsService,
    private readonly chatService: ChatService,
  ) {}

  @Get()
  @ApiOperation({ operationId: 'listReviewComments' })
  @ZodResponse({ status: 200, type: ReviewCommentsDto })
  async list(@Param('runId') runId: string): Promise<ReviewCommentsWire> {
    const comments = await this.reviews.list(runId);
    if (comments === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run ${runId}`);
    }
    return { comments };
  }

  @Post()
  @ApiOperation({ operationId: 'addReviewComment' })
  @ZodResponse({ status: 201, type: ReviewCommentsDto })
  async add(
    @Param('runId') runId: string,
    @Body() body: CreateReviewCommentDto,
  ): Promise<ReviewCommentsWire> {
    return reviewCommentsOrThrow(await this.reviews.add(runId, body));
  }

  /** A draft's new wording, or a sent comment resolved or reopened. */
  @Patch(':commentId')
  @ApiOperation({ operationId: 'editReviewComment' })
  @ZodResponse({ status: 200, type: ReviewCommentsDto })
  async edit(
    @Param('runId') runId: string,
    @Param('commentId') commentId: string,
    @Body() body: EditReviewCommentDto,
  ): Promise<ReviewCommentsWire> {
    return reviewCommentsOrThrow(
      body.status === undefined
        ? await this.reviews.edit(runId, commentId, body.body ?? '')
        : await this.reviews.setStatus(runId, commentId, body.status),
    );
  }

  @Delete(':commentId')
  @ApiOperation({ operationId: 'deleteReviewComment' })
  @ZodResponse({ status: 200, type: ReviewCommentsDto })
  async remove(
    @Param('runId') runId: string,
    @Param('commentId') commentId: string,
  ): Promise<ReviewCommentsWire> {
    return reviewCommentsOrThrow(await this.reviews.remove(runId, commentId));
  }

  /**
   * Every draft as one message, in a turn of its own: 409 `RUN_BUSY` while a
   * turn runs leaves them drafts, and the same `clientMessageId` may be sent again.
   */
  @Post('send')
  @ApiOperation({ operationId: 'sendChatReview' })
  @ZodResponse({ status: 201, type: ReviewSendDto })
  send(
    @Param('runId') runId: string,
    @Body() body: SendReviewDto,
  ): Promise<ReviewSendWire> {
    return this.reviews.send(
      runId,
      { clientMessageId: body.clientMessageId, note: body.note ?? null },
      (message) =>
        this.chatService.sendMessage(runId, message.text, [], {
          clientMessageId: message.clientMessageId,
          storedText: message.storedText,
          review: message.review,
          ownTurn: true,
        }),
    );
  }
}

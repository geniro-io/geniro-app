import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import type { DeliveredWaitingMessageWire } from '../../agents/chat.types';
import { DeliveredWaitingMessageDto } from '../../agents/dto/chat.dto';
import { ThreadDeliveryService } from '../services/thread-delivery.service';

/**
 * The user's Deliver now on a message waiting for a thread. Lives in
 * `v1/teams` beside the delivery it drives; open to paired devices like the
 * waiting list's Remove.
 */
@Controller('v1/threads/:runId/waiting-messages')
@ApiTags('chats')
@ApiBearerAuth()
export class ThreadMessageDeliveryController {
  constructor(private readonly delivery: ThreadDeliveryService) {}

  @Post(':messageId/deliver')
  @HttpCode(200)
  @ApiOperation({ operationId: 'deliverWaitingMessage' })
  @ZodResponse({ status: 200, type: DeliveredWaitingMessageDto })
  deliver(
    @Param('runId') runId: string,
    @Param('messageId') messageId: string,
  ): Promise<DeliveredWaitingMessageWire> {
    return this.delivery.deliverNow(runId, messageId);
  }
}

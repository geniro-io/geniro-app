import { Controller, Delete, Get, HttpCode, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import type { WaitingMessageWire } from '../chat.types';
import { WaitingMessageDto } from '../dto/chat.dto';
import { ThreadInboxService } from '../services/thread-inbox.service';

/**
 * What waits for a thread from other threads, and the user's hand on it. Open
 * to paired devices, which hear about these messages like any other client.
 */
@Controller('v1/threads/:runId/waiting-messages')
@ApiTags('chats')
@ApiBearerAuth()
export class ThreadMessagesController {
  constructor(private readonly inbox: ThreadInboxService) {}

  @Get()
  @ApiOperation({ operationId: 'listWaitingMessages' })
  @ZodResponse({ status: 200, type: [WaitingMessageDto] })
  list(@Param('runId') runId: string): Promise<WaitingMessageWire[]> {
    return this.inbox.listWaiting(runId);
  }

  @Delete(':messageId')
  @HttpCode(204)
  @ApiOperation({ operationId: 'removeWaitingMessage' })
  remove(
    @Param('runId') runId: string,
    @Param('messageId') messageId: string,
  ): Promise<void> {
    return this.inbox.remove(runId, messageId);
  }
}

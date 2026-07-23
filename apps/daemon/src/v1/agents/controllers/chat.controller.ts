import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import type { ItemWire, RunWire } from '../chat.types';
import {
  CreateChatDto,
  HistoryQueryDto,
  RenameRunDto,
  SendMessageDto,
  UpdateChatSettingsDto,
} from '../dto/chat.dto';
import { ChatService } from '../services/chat.service';

/**
 * Loopback chat REST surface (token-gated by the global LoopbackTokenGuard).
 * Commands and history are HTTP; the streamed transcript arrives over the `/ws`
 * Socket.IO channel. Inputs are validated by the global Zod pipe.
 */
@Controller('v1/chats')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  createChat(@Body() dto: CreateChatDto): Promise<RunWire> {
    return this.chatService.createChat(dto);
  }

  @Get()
  listChats(): Promise<RunWire[]> {
    return this.chatService.listChats();
  }

  @Patch(':runId')
  rename(
    @Param('runId') runId: string,
    @Body() dto: RenameRunDto,
  ): Promise<RunWire> {
    return this.chatService.rename(runId, dto.title);
  }

  @Patch(':runId/settings')
  updateSettings(
    @Param('runId') runId: string,
    @Body() dto: UpdateChatSettingsDto,
  ): Promise<RunWire> {
    return this.chatService.updateSettings(runId, dto.approval);
  }

  @Get(':runId/items')
  getHistory(
    @Param('runId') runId: string,
    @Query() query: HistoryQueryDto,
  ): Promise<ItemWire[]> {
    return this.chatService.getHistory(runId, query.afterSeq ?? -1);
  }

  @Post(':runId/messages')
  sendMessage(
    @Param('runId') runId: string,
    @Body() dto: SendMessageDto,
  ): Promise<ItemWire> {
    return this.chatService.sendMessage(runId, dto.text);
  }

  @Post(':runId/cancel')
  cancel(@Param('runId') runId: string): Promise<{ cancelled: boolean }> {
    return this.chatService.cancel(runId);
  }
}

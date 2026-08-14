import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import type {
  AttachmentDataWire,
  ItemWire,
  LocalImageWire,
  RunWire,
} from '../chat.types';
import {
  AttachmentDataDto,
  CancelledDto,
  CreateChatDto,
  DeletedDto,
  HistoryQueryDto,
  ItemDto,
  LocalImageDto,
  LocalImageQueryDto,
  RenameRunDto,
  RunDto,
  SendMessageDto,
  UpdateChatSettingsDto,
} from '../dto/chat.dto';
import { ChatService } from '../services/chat.service';
import { LocalImageService } from '../services/local-image.service';

/**
 * Loopback chat REST surface (token-gated by the global LoopbackTokenGuard).
 * Commands and history are HTTP; the streamed transcript arrives over the `/ws`
 * Socket.IO channel. Inputs are validated by the global Zod pipe; every
 * response is declared with `@ZodResponse`, which type-checks the handler's
 * return value against the schema, serializes it through that schema, and
 * publishes it to the OpenAPI document the renderer's client is generated from.
 */
@Controller('v1/chats')
@ApiTags('chats')
@ApiBearerAuth()
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly localImages: LocalImageService,
  ) {}

  @Post()
  @ApiOperation({ operationId: 'createChat' })
  @ZodResponse({ status: 201, type: RunDto })
  createChat(@Body() dto: CreateChatDto): Promise<RunWire> {
    return this.chatService.createChat(dto);
  }

  @Get()
  @ApiOperation({ operationId: 'listChats' })
  @ZodResponse({ status: 200, type: [RunDto] })
  listChats(): Promise<RunWire[]> {
    return this.chatService.listChats();
  }

  @Patch(':runId')
  @ApiOperation({ operationId: 'renameRun' })
  @ZodResponse({ status: 200, type: RunDto })
  rename(
    @Param('runId') runId: string,
    @Body() dto: RenameRunDto,
  ): Promise<RunWire> {
    return this.chatService.rename(runId, dto.title);
  }

  @Patch(':runId/settings')
  @ApiOperation({ operationId: 'updateChatSettings' })
  @ZodResponse({ status: 200, type: RunDto })
  updateSettings(
    @Param('runId') runId: string,
    @Body() dto: UpdateChatSettingsDto,
  ): Promise<RunWire> {
    return this.chatService.updateSettings(runId, dto);
  }

  @Get(':runId/items')
  @ApiOperation({ operationId: 'listRunItems' })
  @ZodResponse({ status: 200, type: [ItemDto] })
  getHistory(
    @Param('runId') runId: string,
    @Query() query: HistoryQueryDto,
  ): Promise<ItemWire[]> {
    return this.chatService.getHistory(runId, query.afterSeq ?? -1);
  }

  @Post(':runId/messages')
  @ApiOperation({ operationId: 'sendChatMessage' })
  @ZodResponse({ status: 201, type: ItemDto })
  sendMessage(
    @Param('runId') runId: string,
    @Body() dto: SendMessageDto,
  ): Promise<ItemWire> {
    return this.chatService.sendMessage(runId, dto.text, dto.images);
  }

  @Get(':runId/attachments/:attachmentId')
  @ApiOperation({ operationId: 'readChatAttachment' })
  @ZodResponse({ status: 200, type: AttachmentDataDto })
  readAttachment(
    @Param('runId') runId: string,
    @Param('attachmentId') attachmentId: string,
  ): AttachmentDataWire {
    return this.chatService.readAttachment(runId, attachmentId);
  }

  /**
   * An image an agent referenced from its own markdown. A QUERY parameter and
   * not a path segment: the value is a filesystem path, so it carries slashes
   * of its own and no amount of route shaping makes it one segment.
   */
  @Get(':runId/image')
  @ApiOperation({ operationId: 'readLocalImage' })
  @ZodResponse({ status: 200, type: LocalImageDto })
  readLocalImage(
    @Param('runId') runId: string,
    @Query() query: LocalImageQueryDto,
  ): Promise<LocalImageWire> {
    return this.localImages.read(runId, query.path);
  }

  @Post(':runId/cancel')
  @ApiOperation({ operationId: 'cancelChat' })
  @ZodResponse({ status: 200, type: CancelledDto })
  cancel(@Param('runId') runId: string): Promise<{ cancelled: boolean }> {
    return this.chatService.cancel(runId);
  }

  @Delete(':runId')
  @ApiOperation({ operationId: 'deleteChat' })
  @ZodResponse({ status: 200, type: DeletedDto })
  delete(@Param('runId') runId: string): Promise<{ deleted: boolean }> {
    return this.chatService.delete(runId);
  }
}

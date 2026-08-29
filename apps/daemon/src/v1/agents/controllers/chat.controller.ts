import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import type {
  AttachmentDataWire,
  ChatExportWire,
  ChatMetricsWire,
  ChatTotalsResponse,
  ItemWire,
  LocalImageWire,
  RunWire,
  ShellOutputWire,
} from '../chat.types';
import {
  AttachmentDataDto,
  CancelledDto,
  ChatDeletedDto,
  ChatExportDto,
  ChatMetricsDto,
  ChatTotalsDto,
  CreateChatDto,
  ForgottenInstructionsDto,
  HistoryQueryDto,
  ItemDto,
  LocalImageDto,
  LocalImageQueryDto,
  RenameRunDto,
  RunDto,
  SendMessageDto,
  ShellOutputDto,
  ShellOutputQueryDto,
  UpdateChatSettingsDto,
} from '../dto/chat.dto';
import { SetRunGroupDto } from '../dto/run-group.dto';
import { ChatService } from '../services/chat.service';
import { ChatExportService } from '../services/chat-export.service';
import { ChatMetricsService } from '../services/chat-metrics.service';
import { LocalImageService } from '../services/local-image.service';
import { ShellOutputService } from '../services/shell-output.service';

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
    private readonly chatExport: ChatExportService,
    private readonly localImages: LocalImageService,
    private readonly metrics: ChatMetricsService,
    private readonly shellOutput: ShellOutputService,
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

  /**
   * Forget the custom instructions every existing run snapshotted.
   *
   * Declared BEFORE the `:runId` routes so `forget-custom-instructions` is
   * never read as a run id — the same ordering `/v1/groups/reorder` needs.
   */
  @Post('forget-custom-instructions')
  @ApiOperation({ operationId: 'forgetCustomInstructions' })
  @ZodResponse({ status: 200, type: ForgottenInstructionsDto })
  forgetCustomInstructions(): Promise<{ cleared: number }> {
    return this.chatService.forgetCustomInstructions();
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

  /**
   * File this run into a sidebar group, or out of every group (`null`).
   *
   * On the RUN's route rather than the group's because the run is what changes
   * and what the answer is — the sidebar replaces the row it already holds. The
   * group routes own the groups themselves (`/v1/groups`).
   */
  @Put(':runId/group')
  @ApiOperation({ operationId: 'setRunGroup' })
  @ZodResponse({ status: 200, type: RunDto })
  setGroup(
    @Param('runId') runId: string,
    @Body() dto: SetRunGroupDto,
  ): Promise<RunWire> {
    return this.chatService.setGroup(runId, dto.groupId);
  }

  @Get(':runId/items')
  @ApiOperation({ operationId: 'listRunItems' })
  @ZodResponse({ status: 200, type: [ItemDto] })
  getHistory(
    @Param('runId') runId: string,
    @Query() query: HistoryQueryDto,
  ): Promise<ItemWire[]> {
    return this.chatService.getHistory(
      runId,
      query.afterSeq ?? -1,
      query.limit === undefined
        ? undefined
        : { limit: query.limit, beforeSeq: query.beforeSeq },
    );
  }

  /**
   * The whole conversation as one file — every setting, every transcript item
   * with its payload verbatim, the per-node execution state and the spend.
   *
   * Its own route rather than a flag on `:runId/items`, because it answers a
   * different question: that route serves a WINDOW to a screen and is paged
   * behind a cursor, while this is the complete thread for a bug report. It is
   * also the one read here that is deliberately unbounded, which is why it is
   * pressed rather than polled.
   */
  @Get(':runId/export')
  @ApiOperation({ operationId: 'exportChat' })
  @ZodResponse({ status: 200, type: ChatExportDto })
  exportChat(@Param('runId') runId: string): Promise<ChatExportWire> {
    return this.chatExport.export(runId);
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

  /**
   * The terminal behind one command in the running-shells list.
   *
   * A QUERY parameter for the call id and not a path segment, matching the
   * image route beside it: the id is the CLI's own token and nothing here
   * should have to reason about which characters it may contain.
   *
   * Polled while a detached command runs — it is a bounded tail of one file, so
   * unlike `:runId/metrics` (a round trip to the live CLI) it is cheap enough to
   * ask again every couple of seconds.
   */
  @Get(':runId/shell-output')
  @ApiOperation({ operationId: 'readShellOutput' })
  @ZodResponse({ status: 200, type: ShellOutputDto })
  readShellOutput(
    @Param('runId') runId: string,
    @Query() query: ShellOutputQueryDto,
  ): Promise<ShellOutputWire> {
    return this.shellOutput.read(runId, query.callId);
  }

  /**
   * What this chat's context window holds, and what the thread has cost.
   *
   * A GET with a real cost behind it — the breakdown is a round trip to the
   * live CLI, measured at 1.2–3.3s — so it is fetched when the readout is
   * OPENED and never polled. Absent figures are an answer here, not an error:
   * a CLI with no such channel and a chat whose process has been reaped both
   * come back 200 with `breakdownReason` saying which.
   */
  @Get(':runId/metrics')
  @ApiOperation({ operationId: 'readChatMetrics' })
  @ZodResponse({ status: 200, type: ChatMetricsDto })
  readMetrics(@Param('runId') runId: string): Promise<ChatMetricsWire> {
    return this.metrics.read(runId);
  }

  /**
   * What this thread has cost — the spend half of `:runId/metrics`, alone.
   *
   * Its own route because the two halves cost different things to produce. The
   * breakdown is a round trip to the live CLI and is why that route is opened
   * rather than polled; this one is a database sum, so the chat header can carry
   * the figure on every thread the user opens without paying a CLI dial to
   * switch chats.
   */
  @Get(':runId/totals')
  @ApiOperation({ operationId: 'readChatTotals' })
  @ZodResponse({ status: 200, type: ChatTotalsDto })
  async readTotals(@Param('runId') runId: string): Promise<ChatTotalsResponse> {
    return { totals: await this.metrics.readTotals(runId) };
  }

  @Post(':runId/cancel')
  @ApiOperation({ operationId: 'cancelChat' })
  @ZodResponse({ status: 200, type: CancelledDto })
  cancel(@Param('runId') runId: string): Promise<{ cancelled: boolean }> {
    return this.chatService.cancel(runId);
  }

  @Delete(':runId')
  @ApiOperation({ operationId: 'deleteChat' })
  @ZodResponse({ status: 200, type: ChatDeletedDto })
  delete(@Param('runId') runId: string): Promise<{ deleted: boolean }> {
    return this.chatService.delete(runId);
  }
}

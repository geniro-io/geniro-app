import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import type { RunWire } from '../../agents/chat.types';
import { RunDto } from '../../agents/dto/chat.dto';
import type {
  CommandCenterBoard,
  CommandCenterInstructionsConfig,
  CommandCenterStart,
  CommandCenterThreadStartState,
  CommandCenterTimeline,
  SettingsNotice,
} from '../command-center.types';
import {
  CommandCenterBoardDto,
  CommandCenterBoardQueryDto,
  CommandCenterChatsDiscardedDto,
  CommandCenterInstructionsConfigDto,
  CommandCenterStartFailedDto,
  CommandCenterStartsDto,
  CommandCenterStartsQueryDto,
  CommandCenterThreadStartStateDto,
  CommandCenterTimelineDto,
  CommandCenterTimelineQueryDto,
  SettingsNoticeDto,
  SettingsNoticeReadingsDto,
  SettingsNoticesDto,
  StartCommandCenterChatDto,
  StartThreadRunDto,
} from '../dto/command-center.dto';
import { CommandCenterService } from '../services/command-center.service';
import { CommandCenterChatService } from '../services/command-center-chat.service';
import { CommandCenterNoticesService } from '../services/command-center-notices.service';
import { CommandCenterStartsService } from '../services/command-center-starts.service';
import { CommandCenterTimelineService } from '../services/command-center-timeline.service';

@Controller('v1/command-center')
@ApiTags('command-center')
@ApiBearerAuth()
export class CommandCenterController {
  constructor(
    private readonly board: CommandCenterService,
    private readonly managers: CommandCenterChatService,
    private readonly starts: CommandCenterStartsService,
    private readonly timelines: CommandCenterTimelineService,
    private readonly notices: CommandCenterNoticesService,
  ) {}

  /** Every active thread as a card, or just the named ones. */
  @Get('board')
  @ApiOperation({ operationId: 'readCommandCenterBoard' })
  @ZodResponse({ status: 200, type: CommandCenterBoardDto })
  read(
    @Query() query: CommandCenterBoardQueryDto,
  ): Promise<CommandCenterBoard> {
    return this.board.board(query.runIds);
  }

  @Get('timeline')
  @ApiOperation({ operationId: 'listCommandCenterTimeline' })
  @ZodResponse({ status: 200, type: CommandCenterTimelineDto })
  timeline(
    @Query() query: CommandCenterTimelineQueryDto,
  ): Promise<CommandCenterTimeline> {
    return this.timelines.page(
      query.before === undefined ? null : new Date(query.before),
      query.limit,
    );
  }

  /** The manager's chat — the one that exists, or a new one with these chips. */
  @Post('chat')
  @ApiOperation({ operationId: 'openCommandCenterChat' })
  @ZodResponse({ status: 201, type: RunDto })
  open(@Body() dto: StartCommandCenterChatDto): Promise<RunWire> {
    return this.managers.open(dto);
  }

  /**
   * The user's standing instructions for the manager — desktop only, like
   * `PUT /v1/agents/sessions/config`: Electron main pushes it from settings.json.
   */
  @Put('instructions')
  @UseGuards(DesktopOnlyGuard)
  @ApiOperation({ operationId: 'setCommandCenterInstructions' })
  @ZodResponse({ status: 200, type: CommandCenterInstructionsConfigDto })
  setInstructions(
    @Body() body: CommandCenterInstructionsConfigDto,
  ): CommandCenterInstructionsConfig {
    return { instructions: this.managers.setInstructions(body.instructions) };
  }

  /** **Destructive and irreversible**: discard the manager chat and its roster. */
  @Delete('chat')
  @ApiOperation({ operationId: 'discardCommandCenterChat' })
  @ZodResponse({ status: 200, type: CommandCenterChatsDiscardedDto })
  discard(): Promise<{ deleted: number }> {
    return this.managers.reset();
  }

  /** The manager chat's Settings notices, oldest first, for the cards drawn at their rows. */
  @Get('notices')
  @ApiOperation({ operationId: 'listCommandCenterNotices' })
  @ZodResponse({ status: 200, type: SettingsNoticesDto })
  async listNotices(): Promise<{ notices: SettingsNotice[] }> {
    return { notices: await this.notices.list() };
  }

  /** What the desktop window reads of the Geniro update and the agent CLIs — desktop only: those readings live in Electron main. */
  @Put('notices/readings')
  @UseGuards(DesktopOnlyGuard)
  @HttpCode(204)
  @ApiOperation({ operationId: 'reportCommandCenterNoticeReadings' })
  reportNoticeReadings(@Body() dto: SettingsNoticeReadingsDto): Promise<void> {
    return this.notices.report(dto);
  }

  /** The user put a notice away, on any device: its card is gone until a new notice opens. */
  @Post('notices/:noticeId/dismiss')
  @ApiOperation({ operationId: 'dismissCommandCenterNotice' })
  @ZodResponse({ status: 201, type: SettingsNoticeDto })
  dismissNotice(@Param('noticeId') noticeId: string): Promise<SettingsNotice> {
    return this.notices.dismiss(noticeId);
  }

  /** The approved starts Electron main's drain starts. */
  @Get('starts')
  @ApiOperation({ operationId: 'listCommandCenterStarts' })
  @ZodResponse({ status: 200, type: CommandCenterStartsDto })
  async listStarts(
    @Query() _query: CommandCenterStartsQueryDto,
  ): Promise<{ starts: CommandCenterStart[] }> {
    return { starts: await this.starts.approvedStarts() };
  }

  /** Where a cardless start stands, for its Start card. */
  @Get('starts/:startId')
  @ApiOperation({ operationId: 'readCommandCenterThreadStart' })
  @ZodResponse({ status: 200, type: CommandCenterThreadStartStateDto })
  readStart(
    @Param('startId') startId: string,
  ): Promise<CommandCenterThreadStartState> {
    return this.starts.threadStartState(startId);
  }

  /** The drain starts an approved cardless thread in its project's folder — desktop only: only Electron main's drain starts one. */
  @Post('starts/:startId/runs')
  @UseGuards(DesktopOnlyGuard)
  @ApiOperation({ operationId: 'startCommandCenterThreadRun' })
  @ZodResponse({ status: 201, type: CommandCenterThreadStartStateDto })
  startRun(
    @Param('startId') startId: string,
    @Body() dto: StartThreadRunDto,
  ): Promise<CommandCenterThreadStartState> {
    return this.starts.startThreadRun(startId, dto);
  }

  /** The drain could not start it (a card's start, or a cardless one): the request ends and the manager is told — desktop only: only Electron main's drain reports one. */
  @Post('starts/:startId/failed')
  @UseGuards(DesktopOnlyGuard)
  @HttpCode(204)
  @ApiOperation({ operationId: 'reportCommandCenterStartFailed' })
  failed(
    @Param('startId') startId: string,
    @Body() dto: CommandCenterStartFailedDto,
  ): Promise<void> {
    return this.starts.failed(startId, dto.reason);
  }
}

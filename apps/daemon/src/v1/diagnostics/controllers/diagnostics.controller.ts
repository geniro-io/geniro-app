import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import type {
  DebugChannel,
  DebugLogPage,
  DiagnosticsReport,
} from '../diagnostics.types';
import {
  DebugChannelsDto,
  DebugLogPageDto,
  DebugLogQueryDto,
  DebugSettingsDto,
  DiagnosticsReportDto,
  UiLogDto,
} from '../dto/diagnostics.dto';
import { DebugLogService } from '../services/debug-log.service';
import { DiagnosticsReportService } from '../services/diagnostics-report.service';

/**
 * The debug surface: read the log, choose what is recorded, hand the daemon a
 * line the renderer produced, and take a one-paste report.
 *
 * Route + delegation only, like every controller here — the sink, the
 * redaction and the report assembly all live in services.
 */
@Controller('v1/diagnostics')
@ApiTags('diagnostics')
@ApiBearerAuth()
export class DiagnosticsController {
  constructor(
    private readonly log: DebugLogService,
    private readonly report: DiagnosticsReportService,
  ) {}

  @Get('logs')
  @ApiOperation({ operationId: 'readDebugLog' })
  @ZodResponse({ status: 200, type: DebugLogPageDto })
  readLog(@Query() query: DebugLogQueryDto): DebugLogPage {
    return this.log.page(query.afterSeq, query.limit);
  }

  @Put('settings')
  @ApiOperation({ operationId: 'setDebugChannels' })
  @ZodResponse({ status: 200, type: DebugChannelsDto })
  setChannels(@Body() body: DebugSettingsDto): { channels: DebugChannel[] } {
    return { channels: this.log.setChannels(body.channels) };
  }

  /**
   * A line the RENDERER recorded.
   *
   * It goes to the daemon rather than staying in the browser console because
   * the console is not somewhere a user can hand you: it lives behind devtools
   * nobody opens, and it is gone the moment the window reloads. Routed here it
   * lands in the same file and the same ordered stream as everything else, so
   * "the UI threw at 14:02:11" sits next to what the daemon was doing at
   * 14:02:11 — which is the whole reason to have one log rather than two.
   */
  @Post('ui-log')
  @ApiOperation({ operationId: 'recordUiLog' })
  @ZodResponse({ status: 201, type: DebugChannelsDto })
  recordUiLog(@Body() body: UiLogDto): { channels: DebugChannel[] } {
    this.log.recordFromUi(body);
    return { channels: this.log.enabledChannels() };
  }

  @Get('report')
  @ApiOperation({ operationId: 'buildDiagnosticsReport' })
  @ZodResponse({ status: 200, type: DiagnosticsReportDto })
  buildReport(): Promise<DiagnosticsReport> {
    return this.report.build();
  }
}

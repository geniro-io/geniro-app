import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import {
  LineBaselineDto,
  LineBaselineRequestDto,
  LineSnapshotAckDto,
  LineSnapshotDto,
} from '../dto/line-snapshot.dto';
import { UsageStatsDto, UsageStatsQueryDto } from '../dto/stats.dto';
import { StatsService } from '../services/stats.service';
import type { LineBaselineWire, UsageStatsWire } from '../stats.types';

/**
 * What the app has spent, and on what.
 *
 * Route + delegation only, like every controller here — the range resolution,
 * the bucketing and the ranking all live in {@link StatsService}.
 */
@Controller('v1/stats')
@ApiTags('stats')
@ApiBearerAuth()
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('usage')
  @ApiOperation({ operationId: 'readUsageStats' })
  @ZodResponse({ status: 200, type: UsageStatsDto })
  readUsage(@Query() query: UsageStatsQueryDto): Promise<UsageStatsWire> {
    return this.stats.usage(query.from, query.to);
  }

  @Post('line-baselines')
  @ApiOperation({ operationId: 'resolveLineBaseline' })
  @ZodResponse({ status: 201, type: LineBaselineDto })
  resolveLineBaseline(
    @Body() body: LineBaselineRequestDto,
  ): Promise<LineBaselineWire> {
    return this.stats.lineBaseline(body);
  }

  @Post('line-snapshots')
  @ApiOperation({ operationId: 'recordLineSnapshot' })
  @ZodResponse({ status: 201, type: LineSnapshotAckDto })
  async recordLineSnapshot(
    @Body() body: LineSnapshotDto,
  ): Promise<{ recorded: true }> {
    await this.stats.recordLinesSnapshot(body);
    return { recorded: true };
  }
}

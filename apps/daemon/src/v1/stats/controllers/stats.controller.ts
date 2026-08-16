import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { UsageStatsDto, UsageStatsQueryDto } from '../dto/stats.dto';
import { StatsService } from '../services/stats.service';
import type { UsageStatsWire } from '../stats.types';

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
}

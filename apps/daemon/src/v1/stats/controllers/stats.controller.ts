import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import {
  LineBaselineDto,
  LineBaselineRequestDto,
  LineSnapshotAckDto,
  LineSnapshotDto,
} from '../dto/line-snapshot.dto';
import {
  RestoreTeamVersionDto,
  TeamVersionRestoredDto,
  TeamVersionsDto,
  TeamVersionsQueryDto,
  UsageStatsDto,
  UsageStatsQueryDto,
} from '../dto/stats.dto';
import { StatsService } from '../services/stats.service';
import { TeamVersionsService } from '../services/team-versions.service';
import type {
  LineBaselineWire,
  TeamVersionRestoredWire,
  TeamVersionsWire,
  UsageStatsWire,
} from '../stats.types';

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
  constructor(
    private readonly stats: StatsService,
    private readonly versions: TeamVersionsService,
  ) {}

  @Get('usage')
  @ApiOperation({ operationId: 'readUsageStats' })
  @ZodResponse({ status: 200, type: UsageStatsDto })
  readUsage(@Query() query: UsageStatsQueryDto): Promise<UsageStatsWire> {
    return this.stats.usage(query.from, query.to);
  }

  @Get('team-versions')
  @ApiOperation({ operationId: 'readTeamVersions' })
  @ZodResponse({ status: 200, type: TeamVersionsDto })
  readTeamVersions(
    @Query() query: TeamVersionsQueryDto,
  ): Promise<TeamVersionsWire> {
    return this.versions.read(query.slug);
  }

  @Post('team-versions/restore')
  @ApiOperation({ operationId: 'restoreTeamVersion' })
  @ZodResponse({ status: 201, type: TeamVersionRestoredDto })
  restoreTeamVersion(
    @Body() body: RestoreTeamVersionDto,
  ): Promise<TeamVersionRestoredWire> {
    return this.versions.restore(body.slug, body.version, body.baseHash);
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

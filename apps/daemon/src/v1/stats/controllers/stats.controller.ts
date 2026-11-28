import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import {
  LineBaselineDto,
  LineBaselineRequestDto,
  LineSnapshotAckDto,
  LineSnapshotDto,
} from '../dto/line-snapshot.dto';
import {
  RestoreTeamVersionDto,
  TeamStatsDto,
  TeamStatsParamsDto,
  TeamVersionRestoredDto,
  TeamVersionsDto,
  TeamVersionsQueryDto,
  ToolUsageConfigAckDto,
  ToolUsageConfigDto,
  ToolUsageListDto,
  ToolUsageSubjectDto,
  ToolUsageSubjectQueryDto,
  UsageStatsDto,
  UsageStatsQueryDto,
} from '../dto/stats.dto';
import { StatsService } from '../services/stats.service';
import { TeamStatsService } from '../services/team-stats.service';
import { TeamVersionsService } from '../services/team-versions.service';
import { ToolCallLogRetentionService } from '../services/tool-call-log-retention.service';
import { ToolUsageService } from '../services/tool-usage.service';
import type {
  LineBaselineWire,
  TeamStatsWire,
  TeamVersionRestoredWire,
  TeamVersionsWire,
  ToolUsageListWire,
  ToolUsageSubjectWire,
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
    private readonly teamStats: TeamStatsService,
    private readonly toolUsage: ToolUsageService,
    private readonly toolLog: ToolCallLogRetentionService,
  ) {}

  @Get('tool-usage')
  @ApiOperation({ operationId: 'readToolUsage' })
  @ZodResponse({ status: 200, type: ToolUsageListDto })
  readToolUsage(): Promise<ToolUsageListWire> {
    return this.toolUsage.list();
  }

  @Get('tool-usage/subject')
  @ApiOperation({ operationId: 'readToolUsageSubject' })
  @ZodResponse({ status: 200, type: ToolUsageSubjectDto })
  readToolUsageSubject(
    @Query() query: ToolUsageSubjectQueryDto,
  ): Promise<ToolUsageSubjectWire> {
    return this.toolUsage.subject(query);
  }

  /** Desktop only: the value is Electron main's to push from settings.json. */
  @Put('tool-usage/config')
  @UseGuards(DesktopOnlyGuard)
  @ApiOperation({ operationId: 'setToolUsageConfig' })
  @ZodResponse({ status: 200, type: ToolUsageConfigAckDto })
  setToolUsageConfig(@Body() body: ToolUsageConfigDto): {
    toolCallLogRetentionDays: number | null;
  } {
    this.toolLog.configure(body.toolCallLogRetentionDays);
    return { toolCallLogRetentionDays: body.toolCallLogRetentionDays };
  }

  @Get('usage')
  @ApiOperation({ operationId: 'readUsageStats' })
  @ZodResponse({ status: 200, type: UsageStatsDto })
  readUsage(@Query() query: UsageStatsQueryDto): Promise<UsageStatsWire> {
    return this.stats.usage(query.from, query.to);
  }

  @Get('teams/:slug')
  @ApiOperation({ operationId: 'readTeamStats' })
  @ZodResponse({ status: 200, type: TeamStatsDto })
  readTeamStats(@Param() params: TeamStatsParamsDto): Promise<TeamStatsWire> {
    return this.teamStats.read(params.slug);
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

import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import type { RunWire } from '../../agents/chat.types';
import { RunDto } from '../../agents/dto/chat.dto';
import {
  StartSystemAnalysisDto,
  SystemAnalysisListDto,
  SystemAnalysisListQueryDto,
  SystemAnalysisScopeDto,
  SystemAnalysisScopeQueryDto,
  SystemApplyDto,
  SystemApplyResultDto,
} from '../dto/system-analysis.dto';
import { SystemAnalysisService } from '../services/system-analysis.service';
import { SystemAnalysisApplyService } from '../services/system-analysis-apply.service';
import type {
  SystemAnalysisList,
  SystemAnalysisScope,
  SystemApplyResult,
} from '../system-analysis.types';

@Controller('v1/system-analyses')
@ApiTags('SystemAnalyses')
@ApiBearerAuth()
export class SystemAnalysesController {
  constructor(
    private readonly analyses: SystemAnalysisService,
    private readonly applies: SystemAnalysisApplyService,
  ) {}

  /** What the last `days` days hold: the threads with signals, ranked, and the totals. */
  @Get('scope')
  @ApiOperation({ operationId: 'readSystemAnalysisScope' })
  @ZodResponse({ status: 200, type: SystemAnalysisScopeDto })
  scope(
    @Query() query: SystemAnalysisScopeQueryDto,
  ): Promise<SystemAnalysisScope> {
    return this.analyses.scope(query.days);
  }

  /** The system analyses run before, newest first. */
  @Get()
  @ApiOperation({ operationId: 'listSystemAnalyses' })
  @ZodResponse({ status: 200, type: SystemAnalysisListDto })
  list(
    @Query() query: SystemAnalysisListQueryDto,
  ): Promise<SystemAnalysisList> {
    return this.analyses.list(query);
  }

  /**
   * Start a system analysis over the last `days` days, from the Mac only.
   * `SYSTEM_ANALYSIS_NOTHING` when no thread in the period shows a signal.
   */
  @Post()
  @UseGuards(DesktopOnlyGuard)
  @ApiOperation({ operationId: 'startSystemAnalysis' })
  @ZodResponse({ status: 201, type: RunDto })
  start(@Body() dto: StartSystemAnalysisDto): Promise<RunWire> {
    return this.analyses.start(dto);
  }

  /** The report's button: file cards, file and start them, or keep it as a report. */
  @Post(':runId/apply')
  @ApiOperation({ operationId: 'applySystemAnalysis' })
  @ZodResponse({ status: 201, type: SystemApplyResultDto })
  apply(
    @Param('runId') runId: string,
    @Body() dto: SystemApplyDto,
  ): Promise<SystemApplyResult> {
    return this.applies.apply(runId, dto);
  }
}

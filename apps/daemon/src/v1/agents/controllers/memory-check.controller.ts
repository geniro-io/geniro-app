import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import {
  MemoryReviewCheckRequestDto,
  MemoryReviewCheckResultDto,
  MemoryReviewPairsDto,
  MemoryReviewPairsQueryDto,
} from '../../memory/dto/memories.dto';
import type {
  MemoryReviewCheckResult,
  MemoryReviewPairs,
} from '../../memory/memory.types';
import { MemoryCheckService } from '../services/memory-check.service';

/**
 * The cleanup's check for duplicates and contradictions. Desktop only: it runs
 * the Mac's own CLI, billed to the user's account, and a paired device only
 * reads and decides on the stored findings (`MemoriesController`).
 */
@Controller('v1/memories/review')
@ApiTags('memories')
@ApiBearerAuth()
@UseGuards(DesktopOnlyGuard)
export class MemoryCheckController {
  constructor(private readonly checks: MemoryCheckService) {}

  @Get('pairs')
  @ApiOperation({ operationId: 'listMemoryReviewPairs' })
  @ZodResponse({ status: 200, type: MemoryReviewPairsDto })
  pairs(@Query() query: MemoryReviewPairsQueryDto): Promise<MemoryReviewPairs> {
    return this.checks.pairs(query);
  }

  @Post('check')
  @ApiOperation({ operationId: 'checkMemoryReviewPairs' })
  @ZodResponse({ status: 201, type: MemoryReviewCheckResultDto })
  check(
    @Body() body: MemoryReviewCheckRequestDto,
  ): Promise<MemoryReviewCheckResult> {
    return this.checks.check(body);
  }
}

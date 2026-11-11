import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { NotFoundException } from '@packages/common';
import { ZodResponse } from 'nestjs-zod';

import {
  CreateMemoryDto,
  ForgetAllMemoriesDto,
  ForgetMemoryBatchDto,
  MemoryEntryDto,
  MemoryExportDto,
  MemoryForgetBatchListDto,
  MemoryForgetBatchResultDto,
  MemoryKeepResultDto,
  MemoryListDto,
  MemoryListQueryDto,
  MemoryRestoreBatchResultDto,
  MemoryReviewIdsDto,
  MemoryReviewPageDto,
  MemoryReviewQueryDto,
  MemoryReviewSummaryDto,
  UpdateMemoryDto,
} from '../dto/memories.dto';
import type {
  MemoryEntry,
  MemoryExport,
  MemoryForgetAll,
  MemoryForgetBatchList,
  MemoryForgetBatchResult,
  MemoryKeepResult,
  MemoryList,
  MemoryRestoreBatchResult,
  MemoryReviewIds,
  MemoryReviewPage,
  MemoryReviewSummary,
} from '../memory.types';
import { MemoryService } from '../services/memory.service';
import { MemoryReviewService } from '../services/memory-review.service';
import { savedEntryOrThrow } from '../utils/memory-outcome';

/**
 * The user's own view of the shared memory: list, edit, forget, restore,
 * approve, export and clean up. Open to paired devices: the user reads and
 * edits memory from the phone too. Every write is the user's.
 */
@Controller('v1/memories')
@ApiTags('memories')
@ApiBearerAuth()
export class MemoriesController {
  constructor(
    private readonly memory: MemoryService,
    private readonly review: MemoryReviewService,
  ) {}

  @Get()
  @ApiOperation({ operationId: 'listMemories' })
  @ZodResponse({ status: 200, type: MemoryListDto })
  list(@Query() query: MemoryListQueryDto): Promise<MemoryList> {
    return this.memory.list(query);
  }

  @Post()
  @ApiOperation({ operationId: 'createMemory' })
  @ZodResponse({ status: 201, type: MemoryEntryDto })
  async create(@Body() body: CreateMemoryDto): Promise<MemoryEntry> {
    return savedEntryOrThrow(await this.memory.create(body));
  }

  @Get('export')
  @ApiOperation({ operationId: 'exportMemories' })
  @ZodResponse({ status: 200, type: MemoryExportDto })
  export(): Promise<MemoryExport> {
    return this.memory.exportMarkdown();
  }

  @Post('forget-all')
  @ApiOperation({ operationId: 'forgetAllMemories' })
  @ZodResponse({ status: 201, type: ForgetAllMemoriesDto })
  forgetAll(): Promise<MemoryForgetAll> {
    return this.memory.forgetAll();
  }

  @Get('review/summary')
  @ApiOperation({ operationId: 'memoryReviewSummary' })
  @ZodResponse({ status: 200, type: MemoryReviewSummaryDto })
  reviewSummary(): Promise<MemoryReviewSummary> {
    return this.review.summary();
  }

  @Get('review')
  @ApiOperation({ operationId: 'listMemoryReview' })
  @ZodResponse({ status: 200, type: MemoryReviewPageDto })
  reviewPage(@Query() query: MemoryReviewQueryDto): Promise<MemoryReviewPage> {
    return this.review.page(query);
  }

  @Get('review/ids')
  @ApiOperation({ operationId: 'listMemoryReviewIds' })
  @ZodResponse({ status: 200, type: MemoryReviewIdsDto })
  reviewIds(@Query() query: MemoryReviewQueryDto): Promise<MemoryReviewIds> {
    return this.review.ids(query);
  }

  @Post('forget-batch')
  @ApiOperation({ operationId: 'forgetMemoryBatch' })
  @ZodResponse({ status: 201, type: MemoryForgetBatchResultDto })
  forgetBatch(
    @Body() body: ForgetMemoryBatchDto,
  ): Promise<MemoryForgetBatchResult> {
    return this.memory.forgetBatch(body.ids);
  }

  @Get('batches')
  @ApiOperation({ operationId: 'listMemoryBatches' })
  @ZodResponse({ status: 200, type: MemoryForgetBatchListDto })
  batches(): Promise<MemoryForgetBatchList> {
    return this.review.batches();
  }

  @Post('batches/:batchId/restore')
  @ApiOperation({ operationId: 'restoreMemoryBatch' })
  @ZodResponse({ status: 201, type: MemoryRestoreBatchResultDto })
  restoreBatch(
    @Param('batchId') batchId: string,
  ): Promise<MemoryRestoreBatchResult> {
    return this.memory.restoreBatch(batchId);
  }

  @Post(':memoryId/keep')
  @ApiOperation({ operationId: 'keepMemory' })
  @ZodResponse({ status: 201, type: MemoryKeepResultDto })
  keep(@Param('memoryId') memoryId: string): Promise<MemoryKeepResult> {
    return this.setKept(memoryId, true);
  }

  @Post(':memoryId/unkeep')
  @ApiOperation({ operationId: 'unkeepMemory' })
  @ZodResponse({ status: 201, type: MemoryKeepResultDto })
  unkeep(@Param('memoryId') memoryId: string): Promise<MemoryKeepResult> {
    return this.setKept(memoryId, false);
  }

  @Get(':memoryId')
  @ApiOperation({ operationId: 'readMemory' })
  @ZodResponse({ status: 200, type: MemoryEntryDto })
  async read(@Param('memoryId') memoryId: string): Promise<MemoryEntry> {
    const entry = await this.memory.get(memoryId);
    if (entry === null) {
      throw new NotFoundException('MEMORY_NOT_FOUND', `no memory ${memoryId}`);
    }
    return entry;
  }

  @Patch(':memoryId')
  @ApiOperation({ operationId: 'updateMemory' })
  @ZodResponse({ status: 200, type: MemoryEntryDto })
  async update(
    @Param('memoryId') memoryId: string,
    @Body() body: UpdateMemoryDto,
  ): Promise<MemoryEntry> {
    return savedEntryOrThrow(await this.memory.change(memoryId, body));
  }

  private async setKept(
    memoryId: string,
    kept: boolean,
  ): Promise<MemoryKeepResult> {
    const result = await this.memory.setKept(memoryId, kept);
    if (result === null) {
      throw new NotFoundException(
        'MEMORY_NOT_FOUND',
        `no active or waiting memory ${memoryId}`,
      );
    }
    return result;
  }
}

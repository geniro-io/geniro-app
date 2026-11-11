import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BadRequestException, NotFoundException } from '@packages/common';
import { ZodResponse } from 'nestjs-zod';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import {
  CreateMemoryDto,
  ForgetAllMemoriesDto,
  ForgetMemoryBatchDto,
  MemoryEntryDto,
  MemoryExportDto,
  MemoryFindingListDto,
  MemoryForgetBatchListDto,
  MemoryForgetBatchResultDto,
  MemoryKeepResultDto,
  MemoryListDto,
  MemoryListQueryDto,
  MemoryMergeResultDto,
  MemoryPurgeResultDto,
  MemoryRestoreBatchResultDto,
  MemoryReviewIdsDto,
  MemoryReviewPageDto,
  MemoryReviewQueryDto,
  MemoryReviewSummaryDto,
  MergeMemoriesDto,
  MemoryReviewSummaryQueryDto,
  UpdateMemoryDto,
} from '../dto/memories.dto';
import type {
  MemoryEntry,
  MemoryExport,
  MemoryFindingList,
  MemoryForgetAll,
  MemoryForgetBatchList,
  MemoryForgetBatchResult,
  MemoryKeepResult,
  MemoryList,
  MemoryMergeResult,
  MemoryPurgeResult,
  MemoryRestoreBatchResult,
  MemoryReviewIds,
  MemoryReviewPage,
  MemoryReviewSummary,
} from '../memory.types';
import { MemoryService } from '../services/memory.service';
import { MemoryFindingsService } from '../services/memory-findings.service';
import { MemoryReviewService } from '../services/memory-review.service';
import { mergedOrThrow, savedEntryOrThrow } from '../utils/memory-outcome';

/**
 * The user's own view of the shared memory: list, edit, forget, restore,
 * approve, export and clean up, and decide on what a model check found.
 * Open to paired devices: the user reads and edits memory from the phone
 * too — except a purge, the one memory write that cannot be undone. Every
 * write is the user's. The check itself is desktop only, in
 * `MemoryCheckController`.
 */
@Controller('v1/memories')
@ApiTags('memories')
@ApiBearerAuth()
export class MemoriesController {
  constructor(
    private readonly memory: MemoryService,
    private readonly review: MemoryReviewService,
    private readonly findings: MemoryFindingsService,
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
  reviewSummary(
    @Query() query: MemoryReviewSummaryQueryDto,
  ): Promise<MemoryReviewSummary> {
    return this.review.summary(new Date(), query.autoForgetDays);
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

  @Get('review/findings')
  @ApiOperation({ operationId: 'listMemoryFindings' })
  @ZodResponse({ status: 200, type: MemoryFindingListDto })
  async listFindings(): Promise<MemoryFindingList> {
    return { findings: await this.findings.open() };
  }

  @Post('review/findings/:findingId/dismiss')
  @ApiOperation({ operationId: 'dismissMemoryFinding' })
  @ZodResponse({ status: 201, type: MemoryFindingListDto })
  async dismissFinding(
    @Param('findingId') findingId: string,
  ): Promise<MemoryFindingList> {
    if (!(await this.findings.dismiss(findingId))) {
      throw new NotFoundException(
        'MEMORY_FINDING_NOT_FOUND',
        `no finding ${findingId}`,
      );
    }
    return { findings: await this.findings.open() };
  }

  @Post('merge')
  @ApiOperation({ operationId: 'mergeMemories' })
  @ZodResponse({ status: 201, type: MemoryMergeResultDto })
  async merge(@Body() body: MergeMemoriesDto): Promise<MemoryMergeResult> {
    return mergedOrThrow(await this.memory.merge(body));
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

  @Post(':memoryId/purge')
  @UseGuards(DesktopOnlyGuard)
  @ApiOperation({ operationId: 'purgeMemory' })
  @ZodResponse({ status: 201, type: MemoryPurgeResultDto })
  async purge(@Param('memoryId') memoryId: string): Promise<MemoryPurgeResult> {
    const outcome = await this.memory.purge(memoryId);
    if (outcome === 'missing') {
      throw new NotFoundException('MEMORY_NOT_FOUND', `no memory ${memoryId}`);
    }
    if (outcome === 'not-forgotten') {
      throw new BadRequestException(
        'MEMORY_NOT_FORGOTTEN',
        'only a forgotten memory can be deleted permanently',
      );
    }
    return outcome;
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

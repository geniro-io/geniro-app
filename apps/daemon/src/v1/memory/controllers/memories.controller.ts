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
  MemoryEntryDto,
  MemoryExportDto,
  MemoryListDto,
  MemoryListQueryDto,
  UpdateMemoryDto,
} from '../dto/memories.dto';
import type {
  MemoryEntry,
  MemoryExport,
  MemoryForgetAll,
  MemoryList,
} from '../memory.types';
import { MemoryService } from '../services/memory.service';
import { savedEntryOrThrow } from '../utils/memory-outcome';

/**
 * The user's own view of the shared memory: list, edit, forget, restore,
 * approve and export. Open to paired devices: the user reads and edits memory
 * from the phone too. Every write is the user's.
 */
@Controller('v1/memories')
@ApiTags('memories')
@ApiBearerAuth()
export class MemoriesController {
  constructor(private readonly memory: MemoryService) {}

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
}

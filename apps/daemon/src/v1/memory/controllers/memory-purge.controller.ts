import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BadRequestException, NotFoundException } from '@packages/common';
import { ZodResponse } from 'nestjs-zod';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import { MemoryPurgeResultDto } from '../dto/memories.dto';
import type { MemoryPurgeResult } from '../memory.types';
import { MemoryService } from '../services/memory.service';

/**
 * Delete a forgotten entry for good. Desktop only, unlike the rest of the
 * user's memory routes: the one memory write that cannot be undone.
 */
@Controller('v1/memories')
@ApiTags('memories')
@ApiBearerAuth()
@UseGuards(DesktopOnlyGuard)
export class MemoryPurgeController {
  constructor(private readonly memory: MemoryService) {}

  @Post(':memoryId/purge')
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
}

import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import {
  StorageCleanDto,
  StorageJobDto,
  StorageJobReadDto,
  StorageUsageDto,
} from '../dto/storage.dto';
import { StorageService } from '../services/storage.service';
import type { StorageJob, StorageUsage } from '../storage.types';

/**
 * Settings → Storage: what the data folder holds, and the clean-ups that
 * delete from it. Desktop only — a paired device may not delete the Mac's data.
 */
@Controller('v1/storage')
@ApiTags('storage')
@ApiBearerAuth()
@UseGuards(DesktopOnlyGuard)
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Get()
  @ApiOperation({ operationId: 'getStorageUsage' })
  @ZodResponse({ status: 200, type: StorageUsageDto })
  usage(): Promise<StorageUsage> {
    return this.storage.usage();
  }

  /** The clean-up's progress alone, for the page to poll while one runs. */
  @Get('job')
  @ApiOperation({ operationId: 'getStorageJob' })
  @ZodResponse({ status: 200, type: StorageJobReadDto })
  job(): { job: StorageJob | null } {
    return { job: this.storage.job() };
  }

  @Post('clean')
  @ApiOperation({ operationId: 'cleanStorage' })
  @ZodResponse({ status: 201, type: StorageJobDto })
  clean(@Body() body: StorageCleanDto): Promise<StorageJob> {
    return this.storage.start(body.target);
  }
}

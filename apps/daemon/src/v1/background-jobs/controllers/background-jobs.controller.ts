import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import type { BackgroundJobList } from '../background-jobs.types';
import {
  BackgroundJobListDto,
  BackgroundJobListQueryDto,
} from '../dto/background-jobs.dto';
import { BackgroundJobsRegistry } from '../services/background-jobs.registry';

/** The title bar's background work: what runs now and what ran. Open to paired devices: it starts nothing. */
@Controller('v1/background-jobs')
@ApiTags('background-jobs')
@ApiBearerAuth()
export class BackgroundJobsController {
  constructor(private readonly registry: BackgroundJobsRegistry) {}

  @Get()
  @ApiOperation({ operationId: 'listBackgroundJobs' })
  @ZodResponse({ status: 200, type: BackgroundJobListDto })
  list(@Query() query: BackgroundJobListQueryDto): Promise<BackgroundJobList> {
    return this.registry.list(query);
  }
}

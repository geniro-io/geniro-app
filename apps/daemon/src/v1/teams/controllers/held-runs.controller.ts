import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import {
  AnswerHeldRunsDto,
  HeldRunsAnsweredDto,
  HeldRunsDto,
} from '../dto/held-runs.dto';
import { RestartContinuationService } from '../services/restart-continuation.service';
import type { HeldRuns, HeldRunsAnswered } from '../teams.types';

/** The team runs a crash cut off, and the user's choice to continue them. */
@Controller('v1/interrupted-runs')
@ApiTags('teams')
@ApiBearerAuth()
export class HeldRunsController {
  constructor(private readonly continuations: RestartContinuationService) {}

  @Get()
  @ApiOperation({ operationId: 'listHeldRuns' })
  @ZodResponse({ status: 200, type: HeldRunsDto })
  async list(): Promise<HeldRuns> {
    return { runs: await this.continuations.listHeld() };
  }

  @Post('answer')
  @HttpCode(200)
  @ApiOperation({ operationId: 'answerHeldRuns' })
  @ZodResponse({ status: 200, type: HeldRunsAnsweredDto })
  answer(@Body() body: AnswerHeldRunsDto): Promise<HeldRunsAnswered> {
    return this.continuations.answerHeld(body);
  }
}

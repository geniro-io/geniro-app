import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';

import {
  LessonEstimateQueryDto,
  LessonSegmentDto,
  LessonSegmentListDto,
  LessonSegmentListQueryDto,
  LessonsReflectAllDto,
  ThreadLessonEstimateDto,
} from '../dto/lessons.dto';
import type {
  LessonSegmentWire,
  LessonsReflectAll,
  ThreadLessonEstimate,
} from '../lessons.types';
import { LessonOffersService } from '../services/lesson-offers.service';

/**
 * The stretches offered for a reflection — "Not reflected yet" — and what
 * reflecting on a thread would cost. Open to paired devices like "Reflect
 * now": nothing here spends without the user's press.
 */
@Controller('v1/lessons')
@ApiTags('lessons')
@ApiBearerAuth()
export class LessonOffersController {
  constructor(private readonly offers: LessonOffersService) {}

  @Get('segments')
  @ApiOperation({ operationId: 'listLessonSegments' })
  @ZodResponse({ status: 200, type: LessonSegmentListDto })
  async list(
    @Query() query: LessonSegmentListQueryDto,
  ): Promise<{ segments: LessonSegmentWire[] }> {
    return { segments: await this.offers.list(query) };
  }

  /** "Not now": the stretch stays in "Not reflected yet". 409 `LESSON_SEGMENT_DECIDED`. */
  @Post('segments/:segmentId/dismiss')
  @ApiOperation({ operationId: 'dismissLessonSegment' })
  @ZodResponse({ status: 201, type: LessonSegmentDto })
  dismiss(@Param('segmentId') segmentId: string): Promise<LessonSegmentWire> {
    return this.offers.dismiss(segmentId);
  }

  /** "Extract all": a reflection on every waiting stretch. */
  @Post('segments/reflect-all')
  @ApiOperation({ operationId: 'reflectAllLessonSegments' })
  @ZodResponse({ status: 201, type: LessonsReflectAllDto })
  reflectAll(): Promise<LessonsReflectAll> {
    return this.offers.reflectAll();
  }

  @Get('estimate')
  @ApiOperation({ operationId: 'estimateLessons' })
  @ZodResponse({ status: 200, type: ThreadLessonEstimateDto })
  estimate(
    @Query() query: LessonEstimateQueryDto,
  ): Promise<ThreadLessonEstimate> {
    return this.offers.threadEstimate(query);
  }
}

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  LessonEstimateQuerySchema,
  LessonProposalListQuerySchema,
  LessonProposalListSchema,
  LessonProposalWireSchema,
  LessonReflectionFactsSchema,
  LessonSegmentListQuerySchema,
  LessonSegmentListSchema,
  LessonSegmentWireSchema,
  LessonsConfigSchema,
  LessonsReflectAllSchema,
  LessonsReflectStartedSchema,
  ReflectLessonsSchema,
  RejectLessonSchema,
  SaveLessonSchema,
  ThreadLessonEstimateSchema,
  ThreadLessonsStateSchema,
} from '../lessons.types';

export class LessonSegmentListQueryDto extends createZodDto(
  LessonSegmentListQuerySchema,
) {}

export class LessonSegmentListDto extends createZodDto(
  LessonSegmentListSchema,
) {}

export class LessonSegmentDto extends createZodDto(
  z.object(LessonSegmentWireSchema.shape),
) {}

export class LessonsReflectAllDto extends createZodDto(
  LessonsReflectAllSchema,
) {}

export class LessonEstimateQueryDto extends createZodDto(
  LessonEstimateQuerySchema,
) {}

export class ThreadLessonEstimateDto extends createZodDto(
  z.object(ThreadLessonEstimateSchema.shape),
) {}

export class ReflectLessonsDto extends createZodDto(ReflectLessonsSchema) {}

export class LessonsReflectStartedDto extends createZodDto(
  LessonsReflectStartedSchema,
) {}

export class ThreadLessonsStateDto extends createZodDto(
  z.object(ThreadLessonsStateSchema.shape),
) {}

export class LessonProposalListQueryDto extends createZodDto(
  LessonProposalListQuerySchema,
) {}

export class LessonProposalListDto extends createZodDto(
  LessonProposalListSchema,
) {}

export class LessonProposalDto extends createZodDto(
  z.object(LessonProposalWireSchema.shape),
) {}

export class SaveLessonDto extends createZodDto(SaveLessonSchema) {}

export class RejectLessonDto extends createZodDto(RejectLessonSchema) {}

export class LessonReflectionFactsDto extends createZodDto(
  z.object(LessonReflectionFactsSchema.shape),
) {}

/** The settings Electron main pushes; replaces whatever the daemon held. */
export class LessonsConfigDto extends createZodDto(LessonsConfigSchema) {}

/** The settings the daemon now holds. */
export class LessonsConfigAckDto extends createZodDto(
  z.object(LessonsConfigSchema.shape),
) {}

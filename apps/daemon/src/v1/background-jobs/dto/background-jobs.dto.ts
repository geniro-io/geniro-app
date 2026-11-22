import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  BackgroundJobListQuerySchema,
  BackgroundJobListSchema,
} from '../background-jobs.types';

export class BackgroundJobListQueryDto extends createZodDto(
  BackgroundJobListQuerySchema,
) {}

export class BackgroundJobListDto extends createZodDto(
  z.object(BackgroundJobListSchema.shape),
) {}

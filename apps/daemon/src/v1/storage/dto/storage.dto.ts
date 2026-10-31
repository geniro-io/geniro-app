import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  StorageCleanRequestSchema,
  StorageJobReadSchema,
  StorageJobSchema,
  StorageUsageSchema,
} from '../storage.types';

export class StorageUsageDto extends createZodDto(StorageUsageSchema) {}

export class StorageJobReadDto extends createZodDto(StorageJobReadSchema) {}

export class StorageCleanDto extends createZodDto(StorageCleanRequestSchema) {}

export class StorageJobDto extends createZodDto(
  z.object(StorageJobSchema.shape),
) {}

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  MemoryCreateSchema,
  MemoryEntrySchema,
  MemoryExportSchema,
  MemoryForgetAllSchema,
  MemoryImportPreviewRequestSchema,
  MemoryImportPreviewSchema,
  MemoryImportRequestSchema,
  MemoryImportResultSchema,
  MemoryListQuerySchema,
  MemoryListSchema,
  MemoryPatchSchema,
} from '../memory.types';

export class MemoryListQueryDto extends createZodDto(MemoryListQuerySchema) {}

export class MemoryListDto extends createZodDto(
  z.object(MemoryListSchema.shape),
) {}

export class CreateMemoryDto extends createZodDto(MemoryCreateSchema) {}

export class UpdateMemoryDto extends createZodDto(MemoryPatchSchema) {}

export class MemoryEntryDto extends createZodDto(
  z.object(MemoryEntrySchema.shape),
) {}

export class ForgetAllMemoriesDto extends createZodDto(MemoryForgetAllSchema) {}

export class MemoryExportDto extends createZodDto(MemoryExportSchema) {}

export class MemoryImportPreviewRequestDto extends createZodDto(
  MemoryImportPreviewRequestSchema,
) {}

export class MemoryImportPreviewDto extends createZodDto(
  MemoryImportPreviewSchema,
) {}

export class ImportMemoriesDto extends createZodDto(
  MemoryImportRequestSchema,
) {}

export class MemoryImportResultDto extends createZodDto(
  MemoryImportResultSchema,
) {}

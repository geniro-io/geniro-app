import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  KnowledgeCountsSchema,
  KnowledgeCreateSchema,
  KnowledgeDocumentSchema,
  KnowledgeExportQuerySchema,
  KnowledgeExportSchema,
  KnowledgeHeadSchema,
  KnowledgeListQuerySchema,
  KnowledgeListSchema,
  KnowledgePatchSchema,
  KnowledgeRemovedSchema,
  KnowledgeRevisionDetailSchema,
  KnowledgeRevisionListSchema,
  KnowledgeRevisionRestoreSchema,
  KnowledgeRunSearchQuerySchema,
  KnowledgeRunSearchSchema,
} from '../knowledge.types';

export class KnowledgeListQueryDto extends createZodDto(
  KnowledgeListQuerySchema,
) {}

export class KnowledgeListDto extends createZodDto(
  z.object(KnowledgeListSchema.shape),
) {}

export class KnowledgeRunSearchQueryDto extends createZodDto(
  KnowledgeRunSearchQuerySchema,
) {}

export class KnowledgeRunSearchDto extends createZodDto(
  z.object(KnowledgeRunSearchSchema.shape),
) {}

export class KnowledgeCountsDto extends createZodDto(KnowledgeCountsSchema) {}

export class CreateKnowledgeDto extends createZodDto(KnowledgeCreateSchema) {}

export class UpdateKnowledgeDto extends createZodDto(KnowledgePatchSchema) {}

export class KnowledgeDocumentDetailDto extends createZodDto(
  z.object(KnowledgeDocumentSchema.shape),
) {}

export class KnowledgeHeadDetailDto extends createZodDto(
  z.object(KnowledgeHeadSchema.shape),
) {}

export class KnowledgeRemovedDto extends createZodDto(KnowledgeRemovedSchema) {}

export class KnowledgeExportQueryDto extends createZodDto(
  KnowledgeExportQuerySchema,
) {}

export class KnowledgeExportDto extends createZodDto(KnowledgeExportSchema) {}

export class KnowledgeRevisionListDto extends createZodDto(
  KnowledgeRevisionListSchema,
) {}

export class KnowledgeRevisionDetailDto extends createZodDto(
  KnowledgeRevisionDetailSchema,
) {}

export class ApproveKnowledgeDto extends createZodDto(
  KnowledgeRevisionRestoreSchema,
) {}

export class RestoreKnowledgeRevisionDto extends createZodDto(
  KnowledgeRevisionRestoreSchema,
) {}

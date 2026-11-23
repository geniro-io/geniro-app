import { createZodDto } from 'nestjs-zod';

import {
  StartSystemAnalysisSchema,
  SystemAnalysisListQuerySchema,
  SystemAnalysisListSchema,
  SystemAnalysisScopeQuerySchema,
  SystemAnalysisScopeSchema,
  SystemApplyResultSchema,
  SystemApplySchema,
} from '../system-analysis.types';

export class SystemAnalysisScopeQueryDto extends createZodDto(
  SystemAnalysisScopeQuerySchema,
) {}
export class SystemAnalysisScopeDto extends createZodDto(
  SystemAnalysisScopeSchema,
) {}
export class StartSystemAnalysisDto extends createZodDto(
  StartSystemAnalysisSchema,
) {}
export class SystemAnalysisListQueryDto extends createZodDto(
  SystemAnalysisListQuerySchema,
) {}
export class SystemAnalysisListDto extends createZodDto(
  SystemAnalysisListSchema,
) {}
export class SystemApplyDto extends createZodDto(SystemApplySchema) {}
export class SystemApplyResultDto extends createZodDto(
  SystemApplyResultSchema,
) {}

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  PluginApproveRequestSchema,
  PluginBlockListSchema,
  PluginDetailSchema,
  PluginListSchema,
  PluginPatchRequestSchema,
  PluginPressRequestSchema,
  PluginPressResultSchema,
  PluginRemovedSchema,
  PluginRunRequestSchema,
  PluginRunResultSchema,
  PluginSummarySchema,
} from '../plugins.types';

export class PluginListDto extends createZodDto(PluginListSchema) {}

export class PluginBlockListDto extends createZodDto(PluginBlockListSchema) {}

export class PluginDetailDto extends createZodDto(PluginDetailSchema) {}

export class PluginSummaryDto extends createZodDto(
  z.object(PluginSummarySchema.shape),
) {}

export class PluginRunRequestDto extends createZodDto(PluginRunRequestSchema) {}

export class PluginRunResultDto extends createZodDto(
  z.object(PluginRunResultSchema.shape),
) {}

export class PluginPressRequestDto extends createZodDto(
  PluginPressRequestSchema,
) {}

export class PluginPressResultDto extends createZodDto(
  PluginPressResultSchema,
) {}

export class PluginApproveRequestDto extends createZodDto(
  PluginApproveRequestSchema,
) {}

export class PluginPatchRequestDto extends createZodDto(
  PluginPatchRequestSchema,
) {}

export class PluginRemovedDto extends createZodDto(PluginRemovedSchema) {}

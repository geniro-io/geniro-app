import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  DebugChannelSchema,
  DebugLogPageSchema,
  DebugSettingsSchema,
  DiagnosticsReportSchema,
  UiLogInputSchema,
} from '../diagnostics.types';

/**
 * The read cursor. `-1` means "everything the ring still holds", matching the
 * transcript's `afterSeq` convention so the two readers behave the same way.
 */
export class DebugLogQueryDto extends createZodDto(
  z.object({
    afterSeq: z.coerce.number().int().default(-1),
    limit: z.coerce.number().int().min(1).max(2_000).optional(),
  }),
) {}

export class DebugLogPageDto extends createZodDto(DebugLogPageSchema) {}

export class DebugSettingsDto extends createZodDto(DebugSettingsSchema) {}

/** The recording state, echoed back after a change. */
export class DebugChannelsDto extends createZodDto(
  z.object({ channels: z.array(DebugChannelSchema) }),
) {}

export class UiLogDto extends createZodDto(UiLogInputSchema) {}

export class DiagnosticsReportDto extends createZodDto(
  DiagnosticsReportSchema,
) {}

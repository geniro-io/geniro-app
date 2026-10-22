import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  ARTIFACT_ID_PATTERN,
  MAX_ARTIFACT_ID_LENGTH,
  MAX_ARTIFACT_TITLE_LENGTH,
} from '../../agents/chat.types';
import {
  RevokeManyOutcomeSchema,
  ShareConfigSchema,
  ShareDestinationSchema,
  ShareSchema,
  ShareThemeVarsSchema,
} from '../shares.types';

/** The settings Electron main pushes; replaces whatever the daemon held. */
export class ShareConfigDto extends createZodDto(ShareConfigSchema) {}

export class ShareConfigAckDto extends createZodDto(
  z.object({ receivedAt: z.string() }),
) {}

export class ShareListQueryDto extends createZodDto(
  z.object({ runId: z.string().uuid().optional() }),
) {}

/**
 * `configReceivedAt` null means Electron main has not pushed the settings to
 * this daemon yet, so nothing can be shared.
 */
export class ShareListDto extends createZodDto(
  z.object({
    shares: z.array(ShareSchema),
    configReceivedAt: z.string().nullable(),
  }),
) {}

export class CreateShareDto extends createZodDto(
  z.object({
    runId: z.string().uuid(),
    artifactId: z
      .string()
      .regex(ARTIFACT_ID_PATTERN)
      .max(MAX_ARTIFACT_ID_LENGTH),
    title: z.string().trim().min(1).max(MAX_ARTIFACT_TITLE_LENGTH),
    destinationId: z.string().min(1).max(64).optional(),
    themeVars: ShareThemeVarsSchema.optional(),
  }),
) {}

/** The link carries the key in its fragment — show it to the user, never log it. */
export class ShareCreatedDto extends createZodDto(
  z.object({ share: ShareSchema, url: z.string() }),
) {}

export class ShareLinkDto extends createZodDto(z.object({ url: z.string() })) {}

export class RevokeShareDto extends createZodDto(
  z.object({
    status: z.enum(['revoked', 'revoke-failed']),
    detail: z.string().optional(),
  }),
) {}

/** The pages the user saw listed; one shared after the list was read is not among them. */
export class RevokeSharesDto extends createZodDto(
  z.object({
    shareIds: z.array(z.string().min(1).max(64)).min(1),
  }),
) {}

export class RevokeAllSharesDto extends createZodDto(RevokeManyOutcomeSchema) {}

export class ProbeShareDestinationDto extends createZodDto(
  z.object({ destination: ShareDestinationSchema }),
) {}

export class ShareProbeResultDto extends createZodDto(
  z.object({ ok: z.boolean(), detail: z.string() }),
) {}

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  EmbeddingConfigSchema,
  EmbeddingStatusSchema,
} from '../embeddings.types';

/** What Electron main pushes; replaces whatever the daemon held. */
export class EmbeddingConfigDto extends createZodDto(EmbeddingConfigSchema) {}

/** The config the daemon now holds. */
export class EmbeddingConfigAckDto extends createZodDto(
  z.object(EmbeddingConfigSchema.shape),
) {}

export class EmbeddingStatusDto extends createZodDto(EmbeddingStatusSchema) {}

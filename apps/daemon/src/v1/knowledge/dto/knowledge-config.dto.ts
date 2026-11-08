import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { KnowledgeConfigSchema } from '../knowledge.types';

/** The settings Electron main pushes; replaces whatever the daemon held. */
export class KnowledgeConfigDto extends createZodDto(KnowledgeConfigSchema) {}

/** The settings the daemon now holds. */
export class KnowledgeConfigAckDto extends createZodDto(
  z.object(KnowledgeConfigSchema.shape),
) {}

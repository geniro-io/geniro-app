import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { MemoryConfigSchema } from '../memory.types';

/** The settings Electron main pushes; replaces whatever the daemon held. */
export class MemoryConfigDto extends createZodDto(MemoryConfigSchema) {}

/** The settings the daemon now holds. */
export class MemoryConfigAckDto extends createZodDto(
  z.object(MemoryConfigSchema.shape),
) {}

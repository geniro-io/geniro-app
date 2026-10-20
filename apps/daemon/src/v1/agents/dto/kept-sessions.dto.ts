import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { KeptSessionConfigSchema } from '../chat.types';

/** The settings Electron main pushes; replaces whatever the daemon held. */
export class KeptSessionConfigDto extends createZodDto(
  KeptSessionConfigSchema,
) {}

/** The window the daemon now holds, in minutes. */
export class KeptSessionConfigAckDto extends createZodDto(
  z.object({ idleMinutes: z.number().int() }),
) {}

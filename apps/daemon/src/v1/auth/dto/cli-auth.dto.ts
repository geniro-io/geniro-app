import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AgentKindSchema } from '../../runs/runs.types';
import { LoginSessionSchema, LogoutResultSchema } from '../auth.types';

/**
 * Which CLI, and optionally which profile.
 *
 * `configDir` is accepted although the one caller today (Settings) never sends
 * it: an account command is about ONE profile, and the chat surface — where a run
 * carries its own config directory — is the next caller. Omitted means the CLI's
 * own default, never a guessed path.
 */
const AgentQuerySchema = z.object({
  agent: AgentKindSchema,
  configDir: z.string().min(1).optional(),
});

export class CliAuthQueryDto extends createZodDto(AgentQuerySchema) {}

export class LoginSessionDto extends createZodDto(LoginSessionSchema) {}
export class LogoutResultDto extends createZodDto(LogoutResultSchema) {}

export class LoginCodeBodyDto extends createZodDto(
  z.object({
    /** The code the user pasted out of the browser. */
    code: z.string().min(1),
  }),
) {}

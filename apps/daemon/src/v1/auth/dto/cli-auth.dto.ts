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

/**
 * Which MCP server to sign in to, and where from.
 *
 * `cwd` is REQUIRED, unlike the account query's absent one, for the reason the
 * handoff route's is: the CLI resolves a server NAME against the folder it runs
 * in, so a sign-in started anywhere else authenticates a different server or
 * none at all.
 *
 * `.trim()` before `.min(1)`: whitespace is not a server name, and one that got
 * through would compose an invocation whose last argument is a space.
 */
export class McpLoginQueryDto extends createZodDto(
  AgentQuerySchema.extend({
    cwd: z.string().trim().min(1),
    server: z.string().trim().min(1),
  }),
) {}

export class LoginSessionDto extends createZodDto(LoginSessionSchema) {}
export class LogoutResultDto extends createZodDto(LogoutResultSchema) {}

export class LoginCodeBodyDto extends createZodDto(
  z.object({
    /** The code the user pasted out of the browser. */
    code: z.string().min(1),
  }),
) {}

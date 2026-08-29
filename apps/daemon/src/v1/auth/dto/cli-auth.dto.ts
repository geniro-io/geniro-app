import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { cliPositionalArgSchema } from '../../../utils/cli-positional-arg';
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
 * `cwd` matters because the CLI resolves a server NAME against the folder it
 * runs in, so a sign-in started somewhere else authenticates a different server
 * or none at all. OMITTING it is not "anywhere" — it is the one other folder a
 * caller can mean: geniro's own empty directory, which is where a
 * folder-independent LISTING is taken (`v1/agents/utils/folderless-dir.ts`).
 * The graph builder is that caller: a workflow is edited before it runs
 * anywhere, so its node inspector lists the servers that do not depend on a
 * folder, and a name it shows resolves in that same directory and nowhere else.
 * Reading an absent `cwd` as anything the CLI happened to be started in is what
 * this must not become.
 *
 * `server` is the shared {@link cliPositionalArgSchema} — see its doc block
 * for why a leading dash is refused; sharing it with `mcp.dto.ts`'s toggle
 * body is what keeps the two routes from drifting back apart on the same
 * argv shape.
 */
export const mcpLoginQuerySchema = AgentQuerySchema.extend({
  cwd: z.string().trim().min(1).optional(),
  server: cliPositionalArgSchema,
});
export class McpLoginQueryDto extends createZodDto(mcpLoginQuerySchema) {}

export class LoginSessionDto extends createZodDto(LoginSessionSchema) {}
export class LogoutResultDto extends createZodDto(LogoutResultSchema) {}

export class LoginCodeBodyDto extends createZodDto(
  z.object({
    /** The code the user pasted out of the browser. */
    code: z.string().min(1),
  }),
) {}

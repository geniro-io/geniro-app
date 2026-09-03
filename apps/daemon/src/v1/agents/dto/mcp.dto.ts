import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { cliPositionalArgSchema } from '../../../utils/cli-positional-arg';
import { AgentKindSchema } from '../../runs/runs.types';
import { AgentMcpListingWireSchema } from '../chat.types';

/**
 * Query for the MCP-server listing — which agent, and the folder whose servers
 * it would load (validated server-side by `resolveValidCwd`). `refresh` skips
 * the cached health reading; it is what the panel's Refresh control sets, and
 * the only way a server that has since recovered is re-dialled.
 *
 * `cwd` is OPTIONAL because the graph builder genuinely has no folder — a
 * workflow is edited long before it runs in one. Omitting it asks for the set
 * that does not depend on a folder (the user's global servers, plus whatever
 * `configDir` brings); the project-scope servers of whichever folder the run
 * lands in are added by the CLI itself at run time.
 *
 * `configDir` is a node's own agent config directory (validated server-side by
 * `resolveValidConfigDir`). A profile carries its own MCP servers, which is what
 * makes two agent nodes' listings genuinely differ.
 */
export const listMcpServersQuerySchema = z.object({
  agent: AgentKindSchema,
  cwd: z.string().min(1).optional(),
  configDir: z.string().min(1).optional(),
  refresh: z.stringbool().optional(),
});
export class ListMcpServersQueryDto extends createZodDto(
  listMcpServersQuerySchema,
) {}

/**
 * Body for switching one server on or off, for one agent in one folder.
 *
 * The server is named rather than indexed: the listing is re-read between the
 * render and the click, and a position would silently retarget if the set
 * changed underneath.
 *
 * `server` is the shared {@link cliPositionalArgSchema}: this value reaches
 * `cursor-agent mcp enable|disable <server>` / `mcp list-tools <server>` as a
 * trailing positional, the identical argv shape `cli-auth.dto.ts`'s
 * `mcpLoginQuerySchema.server` guards against a leading-dash flag injection —
 * one schema so the two routes cannot drift apart on the same guard again.
 *
 * `configDir` names the same profile {@link listMcpServersQuerySchema} does,
 * and it is here because the WRITE has to land in the file the READ was taken
 * from. Without it this route read a profile's servers and then edited the
 * CLI's default config: under a custom config directory the switch moved on
 * screen, changed nothing for that profile, and silently rewrote the default
 * profile's disabled list instead — the silent no-op
 * {@link AgentMcpService.setEnabled} exists to refuse.
 */
export const setMcpServerEnabledSchema = z.object({
  agent: AgentKindSchema,
  cwd: z.string().min(1),
  configDir: z.string().min(1).optional(),
  server: cliPositionalArgSchema,
  /** True to load the server on the next turn, false to leave it out. */
  enabled: z.boolean(),
});
export class SetMcpServerEnabledDto extends createZodDto(
  setMcpServerEnabledSchema,
) {}

/**
 * Body for re-dialling ONE server and answering with the listing that results.
 *
 * Deliberately not a flag on {@link listMcpServersQuerySchema}: `refresh` there
 * re-dials EVERY server the folder loads (~30s on a 47-server profile), and
 * this exists precisely because that is the wrong price for re-checking one row
 * after a browser sign-in. Same shape as the toggle body minus `enabled` —
 * `server` takes the shared {@link cliPositionalArgSchema} for the same reason
 * it does there.
 *
 * A POST rather than a GET because it DIALS: asking costs a spawned process
 * that starts the user's own server, which is not what a GET promises.
 */
export const recheckMcpServerSchema = z.object({
  agent: AgentKindSchema,
  cwd: z.string().min(1),
  configDir: z.string().min(1).optional(),
  server: cliPositionalArgSchema,
});
export class RecheckMcpServerDto extends createZodDto(recheckMcpServerSchema) {}

/** One agent's MCP servers in a working directory, or why it cannot be asked. */
export class AgentMcpListingDto extends createZodDto(
  AgentMcpListingWireSchema,
) {}

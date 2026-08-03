import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AgentKindSchema } from '../../runs/runs.types';
import { AgentMcpListingWireSchema } from '../chat.types';

/**
 * Query for the MCP-server listing — which agent, and the folder whose servers
 * it would load (validated server-side by `resolveValidCwd`). `refresh` skips
 * the cached health reading; it is what the panel's Refresh control sets, and
 * the only way a server that has since recovered is re-dialled.
 */
export const listMcpServersQuerySchema = z.object({
  agent: AgentKindSchema,
  cwd: z.string().min(1),
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
 */
export const setMcpServerEnabledSchema = z.object({
  agent: AgentKindSchema,
  cwd: z.string().min(1),
  server: z.string().min(1),
  /** True to load the server on the next turn, false to leave it out. */
  enabled: z.boolean(),
});
export class SetMcpServerEnabledDto extends createZodDto(
  setMcpServerEnabledSchema,
) {}

/** One agent's MCP servers in a working directory, or why it cannot be asked. */
export class AgentMcpListingDto extends createZodDto(
  AgentMcpListingWireSchema,
) {}

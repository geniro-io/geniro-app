import { z } from 'zod';

/**
 * A value that rides straight into a spawned CLI's argv as a trailing
 * positional argument — an MCP server name today (a sign-in target, or a
 * toggle target), and anything else added later that reaches a child process
 * the same way.
 *
 * Refuses a LEADING DASH: such a value is read by the CLI as a FLAG rather
 * than the positional it names, so a caller who holds only the loopback
 * bearer token could otherwise steer the child's own flags (argument
 * injection) through a field meant to carry a server name.
 * `.trim()` runs first — whitespace is not a name, and one that slipped
 * through would compose an invocation whose last argument is a space.
 *
 * ONE schema for every DTO that accepts such a value
 * (`v1/auth/dto/cli-auth.dto.ts`'s `mcpLoginQuerySchema.server`,
 * `v1/agents/dto/mcp.dto.ts`'s `setMcpServerEnabledSchema.server`) — living
 * outside both modules is what lets each import it without reaching into the
 * other's `dto/` directory, and is what keeps the guard from drifting back
 * out of sync between two routes that hand the identical argv shape to two
 * different CLI subcommands (`mcp add`/login vs `mcp enable|disable`/
 * `mcp list-tools`).
 */
export const cliPositionalArgSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.startsWith('-'), 'must not start with a dash');

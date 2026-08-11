import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AgentKindSchema } from '../../runs/runs.types';
import { HandoffTargetSchema } from '../handoff.types';

/**
 * The root schema deliberately carries NO `.meta({ id })`: nestjs-zod would
 * then register the component under that id while the response still points at
 * the DTO class name, and `setupSwagger` fails the boot on the dangling `$ref`.
 */
export class HandoffTargetDto extends createZodDto(HandoffTargetSchema) {}

export const HandoffQuerySchema = z.object({
  runId: z.string().min(1),
  /** The graph node; omitted for a single-agent chat. */
  nodeId: z.string().min(1).optional(),
  /**
   * A specific thread of that node — a call thread's own resume id. Omitted
   * means the node's latest session.
   */
  sessionId: z.string().min(1).optional(),
});
export class HandoffQueryDto extends createZodDto(HandoffQuerySchema) {}

/**
 * Which MCP server to sign in to, and where from.
 *
 * `cwd` is REQUIRED, unlike the listing route's optional one. A listing may be
 * asked folder-lessly (the graph builder has no folder yet) and answer with the
 * servers that do not depend on one; a sign-in cannot — the CLI resolves a
 * server name against the folder it runs in, so an invocation without one
 * authenticates a different server or nothing at all.
 *
 * `.trim()` before `.min(1)`: whitespace is not a server name, and letting one
 * through would compose an invocation whose final argument is a space.
 */
export const McpLoginQuerySchema = z.object({
  agent: AgentKindSchema,
  cwd: z.string().trim().min(1),
  server: z.string().trim().min(1),
});
export class McpLoginQueryDto extends createZodDto(McpLoginQuerySchema) {}

/**
 * Which CLI to sign in, and optionally where from.
 *
 * `cwd` is OPTIONAL here, unlike {@link McpLoginQuerySchema}'s required one,
 * and the difference is the question each answers: an MCP server name is
 * resolved against a folder, so signing one in without a folder authenticates
 * the wrong server or none. A CLI's own account is machine-wide — `claude auth
 * login` signs in the same account from anywhere — so demanding a folder would
 * refuse the case this exists for, an expired session hit from a screen that
 * has no run open.
 */
export const CliLoginQuerySchema = z.object({
  agent: AgentKindSchema,
  cwd: z.string().trim().min(1).optional(),
});
export class CliLoginQueryDto extends createZodDto(CliLoginQuerySchema) {}

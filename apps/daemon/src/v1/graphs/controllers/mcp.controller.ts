import { Controller, Delete, Get, Param, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { McpServerService } from '../services/mcp-server.service';

/**
 * Routes for the per-run MCP endpoint (`/v1/mcp/<runId>/<callerNodeId>`).
 * Route + delegation only — the whole MCP protocol (SDK server, transport,
 * tool dispatch, in-protocol error mapping) lives in McpServerService.
 *
 * Kept OUT of the OpenAPI document: this is a JSON-RPC channel spoken by
 * caller agents over a per-node token, not a REST resource the renderer's
 * generated client should ever see. Its payloads are the MCP wire protocol and
 * its handlers write through `@Res()`, so there is no response shape for
 * swagger to describe either.
 */
@ApiExcludeController()
@Controller('v1/mcp')
export class McpController {
  constructor(private readonly mcpServer: McpServerService) {}

  @Post(':runId/:nodeId')
  async handle(
    @Param('runId') runId: string,
    @Param('nodeId') nodeId: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.mcpServer.handlePost(runId, nodeId, req, reply);
  }

  /**
   * GET (a server-initiated SSE stream) is 405: a stateless streamable-http
   * server has none. Declared as its OWN handler — a single method stacking
   * `@Get`+`@Delete` keeps only the last-applied decorator's route (Nest
   * overwrites the `method` metadata), so DELETE would escape to the global
   * filter. `@All` is worse — it re-registers POST and trips Fastify's
   * duplicate-route check.
   */
  @Get(':runId/:nodeId')
  getNotAllowed(@Res() reply: FastifyReply): void {
    this.mcpServer.methodNotAllowed(reply);
  }

  /** DELETE (session teardown) is 405 — a stateless server has no session. */
  @Delete(':runId/:nodeId')
  deleteNotAllowed(@Res() reply: FastifyReply): void {
    this.mcpServer.methodNotAllowed(reply);
  }
}

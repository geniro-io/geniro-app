import { Controller, Delete, Get, Param, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { McpServerService } from '../services/mcp-server.service';

/**
 * Routes for the per-run MCP endpoint (`/v1/mcp/<runId>/<callerNodeId>`, and
 * `/v1/mcp/<runId>/<callerNodeId>/<conversationId>` for a turn answering a
 * call — the conversation is part of WHO calls, see `utils/caller-key.ts`).
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
   * The same endpoint for one CONVERSATION of the node — what every turn that
   * answers a call is handed, so the calls it makes are owned by that call's
   * conversation rather than by the node. The per-node call token opens it
   * exactly as it opens the node's own route (the guard binds the first two
   * segments).
   */
  @Post(':runId/:nodeId/:conversationId')
  async handleConversation(
    @Param('runId') runId: string,
    @Param('nodeId') nodeId: string,
    @Param('conversationId') conversationId: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.mcpServer.handlePost(runId, nodeId, req, reply, conversationId);
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

  /** GET on a conversation's endpoint — 405, on the node route's terms. */
  @Get(':runId/:nodeId/:conversationId')
  getConversationNotAllowed(@Res() reply: FastifyReply): void {
    this.mcpServer.methodNotAllowed(reply);
  }

  /** DELETE on a conversation's endpoint — 405, on the node route's terms. */
  @Delete(':runId/:nodeId/:conversationId')
  deleteConversationNotAllowed(@Res() reply: FastifyReply): void {
    this.mcpServer.methodNotAllowed(reply);
  }
}

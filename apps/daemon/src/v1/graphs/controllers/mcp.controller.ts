import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  Controller,
  Delete,
  Get,
  Inject,
  Logger,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { RUNTIME_TOKEN, type RuntimeInfo } from '../../../auth/runtime';
import {
  CallBroker,
  type CallEnvelope,
  type CallMode,
} from '../services/call-broker.service';
import { flattenRole } from '../utils/role-text';

/** call_agent `mode` values, mirrored in the tool's JSON Schema below. */
const CALL_MODES: readonly CallMode[] = ['sync', 'async', 'fire_and_forget'];

/** Role text is embedded in the tool description — keep it one-line short. */
function shortRole(role: string | undefined): string {
  const flat = flattenRole(role, 118);
  return flat ? ` — ${flat}` : '';
}

/**
 * The per-run MCP endpoint (`POST /v1/mcp/<runId>/<callerNodeId>`) serving
 * exactly two tools — call_agent and await_agent — to caller agents over the
 * streamable-http transport. Stateless by design: every POST builds a fresh
 * SDK `Server` + transport pair (no session ids, plain JSON responses), so
 * nothing leaks between requests and the per-run call token in the guard is
 * the only session there is. Tool results are ALWAYS the broker's envelope
 * (`{status, result?, error?}`) serialized as text — never bare text.
 *
 * Errors are answered in-protocol (JSON-RPC) inside this controller: the
 * global ExceptionsFilter emits Nest-shaped `{statusCode, code, …}` bodies
 * an MCP client cannot parse, so nothing may escape to it.
 */
@Controller('v1/mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(
    private readonly broker: CallBroker,
    @Inject(RUNTIME_TOKEN) private readonly runtime: RuntimeInfo,
  ) {}

  @Post(':runId/:nodeId')
  async handle(
    @Param('runId') runId: string,
    @Param('nodeId') nodeId: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Fastify must not double-send: the SDK transport writes to the raw
    // response stream directly.
    reply.hijack();
    const res = reply.raw;
    try {
      const server = this.buildServer(runId, nodeId);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req.raw, res, req.body);
    } catch (err) {
      // The real message may carry internal paths — log it daemon-side, hand
      // the caller a fixed JSON-RPC error (never the Nest ExceptionsFilter's
      // {statusCode, code, …} body, which an MCP client can't parse).
      this.logger.error(
        `MCP request failed for run ${runId}/${nodeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      if (!res.writableEnded) {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'internal error' },
            id: null,
          }),
        );
      }
    }
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
    this.methodNotAllowed(reply);
  }

  /** DELETE (session teardown) is 405 — a stateless server has no session. */
  @Delete(':runId/:nodeId')
  deleteNotAllowed(@Res() reply: FastifyReply): void {
    this.methodNotAllowed(reply);
  }

  private methodNotAllowed(reply: FastifyReply): void {
    void reply
      .status(405)
      .header('allow', 'POST')
      .send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method Not Allowed — POST only' },
        id: null,
      });
  }

  /** One fresh, stateless SDK server scoped to (run, caller node). */
  private buildServer(runId: string, nodeId: string): Server {
    const server = new Server(
      { name: 'geniro-daemon', version: this.runtime.version },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => {
      const callees = this.broker.listCallees(runId, nodeId);
      const callable =
        callees
          .map(
            (callee) => `${callee.name ?? callee.id}${shortRole(callee.role)}`,
          )
          .join('; ') || 'none';
      return {
        tools: [
          {
            name: 'call_agent',
            description:
              `Invoke one of your call-wired agents and get its result envelope. Callable now: ${callable}. ` +
              'A sync call can take minutes — for long tasks or parallel fan-out prefer mode "async" and collect with await_agent.',
            inputSchema: {
              type: 'object',
              properties: {
                agent: {
                  type: 'string',
                  description:
                    'The callee — its node id or display name from your "May call" list.',
                },
                message: {
                  type: 'string',
                  description:
                    'The task for the callee. It starts a FRESH turn seeing only this text (plus its own role) — include all context it needs.',
                },
                mode: {
                  type: 'string',
                  enum: [...CALL_MODES],
                  description:
                    'sync (default) waits for the result; async returns a call_id at once — collect it later with await_agent; fire_and_forget never returns a result.',
                },
              },
              required: ['agent', 'message'],
            },
          },
          {
            name: 'await_agent',
            description:
              'Collect the result envelope of one of YOUR earlier async call_agent calls. Blocks until that callee finishes.',
            inputSchema: {
              type: 'object',
              properties: {
                call_id: {
                  type: 'string',
                  description: 'The call_id an async call_agent returned.',
                },
              },
              required: ['call_id'],
            },
          },
        ],
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      let envelope: CallEnvelope;
      if (name === 'call_agent') {
        envelope =
          validateCallAgentArgs(args) ??
          (await this.broker.callAgent(runId, nodeId, {
            agent: args.agent as string,
            message: args.message as string,
            mode: args.mode as CallMode | undefined,
          }));
      } else if (name === 'await_agent') {
        envelope =
          validateAwaitAgentArgs(args) ??
          (await this.broker.awaitAgent(runId, nodeId, {
            call_id: args.call_id as string,
          }));
      } else {
        envelope = {
          status: 'error',
          error: `UNKNOWN_TOOL: '${name}' — this endpoint serves call_agent and await_agent`,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope) }],
        isError: envelope.status !== 'ok',
      };
    });

    return server;
  }
}

/** Arg validation happens in-envelope — never throw across the transport. */
function validateCallAgentArgs(
  args: Record<string, unknown>,
): CallEnvelope | null {
  if (typeof args.agent !== 'string' || args.agent.trim().length === 0) {
    return invalidArgs("'agent' must be a non-empty string");
  }
  if (typeof args.message !== 'string' || args.message.length === 0) {
    return invalidArgs("'message' must be a non-empty string");
  }
  if (args.mode !== undefined && !CALL_MODES.includes(args.mode as CallMode)) {
    return invalidArgs("'mode' must be sync, async, or fire_and_forget");
  }
  return null;
}

function validateAwaitAgentArgs(
  args: Record<string, unknown>,
): CallEnvelope | null {
  if (typeof args.call_id !== 'string' || args.call_id.length === 0) {
    return invalidArgs("'call_id' must be a non-empty string");
  }
  return null;
}

function invalidArgs(message: string): CallEnvelope {
  return { status: 'error', error: `INVALID_ARGS: ${message}` };
}

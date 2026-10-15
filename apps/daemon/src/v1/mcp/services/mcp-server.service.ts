import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  ListToolsRequestSchema,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { cameViaRemote } from '../../../auth/remote-marker';
import { RUNTIME_TOKEN, type RuntimeInfo } from '../../../auth/runtime';
import type { CallEnvelope } from '../../graphs/graphs.types';
import { callerKey } from '../../graphs/utils/caller-key';
import { closeQuietly } from '../../graphs/utils/close-quietly';
import type { McpCallContext, McpTool } from '../mcp.types';
import { MCP_TOOLS } from '../tools/mcp-tools';

/**
 * The MCP protocol host behind the per-run endpoint
 * (`POST /v1/mcp/<runId>/<nodeId>`, see McpController), serving the tools THIS
 * node can use over the streamable-http transport: the call surface
 * (call_agent / await_agent / answer_agent) to a node with callees,
 * `ask_user_question` to a turn whose CLI cannot ask its user anything on its
 * own, and the RENDER family — `report_findings`, `show_chart`, `show_metrics`,
 * `show_comparison`, `show_gallery`, `propose_patch` and `propose_plan` — to a
 * turn whose transcript can draw them.
 * The listing is composed per request rather than fixed, so a chat is
 * never offered agents to call and a graph node is never offered a card
 * nobody is watching. Stateless by design: every POST builds a fresh
 * SDK `Server` + transport pair (no session ids, plain JSON responses), so
 * nothing leaks between requests and the per-run call token in the guard is
 * the only session there is.
 *
 * The tools themselves are not written here: each is one directory under
 * `tools/`, and this host only asks every entry what it offers and hands a
 * call to the entry that answers its name. What stays here is what outlives
 * the per-request SDK server — the transport, and the cancellation map a
 * parking tool waits under.
 *
 * A CALL tool's result is always the broker's envelope
 * (`{status, result?, error?}`) serialized as text — that envelope is a
 * contract between two AGENTS. The two HOST tools answer in their own shapes
 * instead, and deliberately: neither a question put to a person nor a card
 * drawn in this app has a status, a call_id, or anything to collect later.
 *
 * Errors are answered in-protocol (JSON-RPC) inside this service: the global
 * ExceptionsFilter emits Nest-shaped `{statusCode, code, …}` bodies an MCP
 * client cannot parse, so nothing may escape to it.
 */
@Injectable()
export class McpServerService {
  private readonly logger = new Logger(McpServerService.name);

  /**
   * The PARKING tool calls currently in flight, keyed by (run, node, JSON-RPC
   * request id), so a cancellation can reach the one it names.
   *
   * The SDK's own `notifications/cancelled` handling cannot reach it, and that
   * is a consequence of this server being STATELESS: the notification arrives
   * as its OWN POST, on a fresh transport and a fresh `Server` whose in-flight
   * map is empty, so the built-in handler looks the request up, finds nothing
   * and aborts nothing. Hence one map on the SERVICE, which outlives both.
   *
   * Measured on cursor-agent (run `4829d8ed`, 2026-09-01): an
   * `ask_user_question` call parked at 10:35:29.069 was followed at
   * 10:36:29.070 — 60.001s, that client's request deadline — by exactly this
   * second POST, while the card went on sitting on screen. What the abort
   * finally does is `ChatService`'s `abandonOnCancel`.
   */
  private readonly inFlightCalls = new Map<string, AbortController>();

  constructor(
    /** Every tool this endpoint serves, in listing order (`tools/mcp-tools.ts`). */
    @Inject(MCP_TOOLS) private readonly tools: readonly McpTool[],
    @Inject(RUNTIME_TOKEN) private readonly runtime: RuntimeInfo,
  ) {}

  /** Serve one stateless MCP request for `(run, caller node)`. */
  async handlePost(
    runId: string,
    nodeId: string,
    req: FastifyRequest,
    reply: FastifyReply,
    /**
     * The callee conversation the asking process speaks in — the endpoint's
     * last segment, handed to every turn that answers a call — or null for
     * the node's own. What makes the caller of the call tools a CONVERSATION
     * rather than a node (`utils/caller-key.ts`).
     */
    conversationId: string | null = null,
  ): Promise<void> {
    // Fastify must not double-send: the SDK transport writes to the raw
    // response stream directly.
    reply.hijack();
    const res = reply.raw;
    // Trips when this response's socket closes — the ONE signal that says a
    // reply can no longer be delivered. `whileCancellable` beside it answers a
    // different question: that one is the client's own
    // `notifications/cancelled`, which a client that simply dropped the
    // connection never gets to send. A claude CLI aborting its own fetch after
    // ~338s is exactly that case, and it is why `await_agent` needs this
    // rather than the cancellation map.
    const gone = new AbortController();
    try {
      const server = this.buildServer(
        runId,
        nodeId,
        gone.signal,
        conversationId,
        cameViaRemote(req.headers),
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        // BEFORE the teardown: a handler still blocked on a callee has to
        // learn that its reader has gone while it can still decline to consume
        // what it was waiting for.
        gone.abort();
        closeQuietly(transport);
        closeQuietly(server);
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

  /** The JSON-RPC 405 for the non-POST methods a stateless server rejects. */
  methodNotAllowed(reply: FastifyReply): void {
    void reply
      .status(405)
      .header('allow', 'POST')
      .send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method Not Allowed — POST only' },
        id: null,
      });
  }

  /**
   * The key one in-flight parking call is tracked and cancelled under —
   * `nodeId` being a caller key, since two processes of one node number their
   * requests independently, and a cancellation from one must not reach the
   * other's call that happens to share its id.
   */
  private callKey(runId: string, nodeId: string, requestId: RequestId): string {
    return `${runId}::${nodeId}::${String(requestId)}`;
  }

  /**
   * Run one PARKING tool call under a signal a later cancellation can trip.
   *
   * Only the tools that WAIT need this: the three that wait on a person, and
   * the two call tools that wait on a callee (`await_agent`, a sync
   * `call_agent`). The drawing tools resolve the moment their row is durable,
   * so there is never a window in which a cancellation could arrive for one.
   */
  private async whileCancellable<TOutcome>(
    runId: string,
    nodeId: string,
    requestId: RequestId,
    call: (signal: AbortSignal) => Promise<TOutcome>,
  ): Promise<TOutcome> {
    const key = this.callKey(runId, nodeId, requestId);
    const controller = new AbortController();
    this.inFlightCalls.set(key, controller);
    try {
      return await call(controller.signal);
    } finally {
      // Identity-checked for `HostSinkBroker.register`'s reason: an id is the
      // CLIENT's to choose and both shipped CLIs restart their numbering per
      // process, so a settling call must never evict a live entry a later call
      // filed under the same key.
      if (this.inFlightCalls.get(key) === controller) {
        this.inFlightCalls.delete(key);
      }
    }
  }

  /** Trip the signal of one in-flight parking call, if it is still running. */
  private cancelCall(
    runId: string,
    nodeId: string,
    requestId: RequestId,
  ): void {
    const key = this.callKey(runId, nodeId, requestId);
    const controller = this.inFlightCalls.get(key);
    if (controller === undefined) {
      return;
    }
    this.inFlightCalls.delete(key);
    this.logger.log(
      `run ${runId}/${nodeId}: the agent cancelled request ${String(requestId)} — closing the card it was parked on`,
    );
    controller.abort();
  }

  /** One fresh, stateless SDK server scoped to (run, caller node). */
  private buildServer(
    runId: string,
    nodeId: string,
    /**
     * Trips when the HTTP request being served goes away. Optional so a caller
     * that builds a server outside a request (a test) needs no controller.
     */
    gone?: AbortSignal,
    /** See `handlePost` — null for the node's own conversation. */
    conversationId: string | null = null,
    /** Whether the gateway proxied the request from a paired device. */
    remote = false,
  ): Server {
    // WHO calls, for the call tools: this node, in this conversation.
    const caller = callerKey(nodeId, conversationId);
    const server = new Server(
      { name: 'geniro-daemon', version: this.runtime.version },
      { capabilities: { tools: {} } },
    );

    // REPLACES the `Protocol` base class's own handler, deliberately. Its
    // version aborts the matching entry of THIS instance's in-flight map, which
    // in a stateless server is always empty (see `inFlightCalls`) — so nothing
    // is lost by taking the notification over, and leaving the default in place
    // is what let a parked card outlive the call it belonged to.
    server.setNotificationHandler(
      CancelledNotificationSchema,
      (notification) => {
        const requestId = notification.params.requestId;
        // The id is what names WHICH call was given up on, and this endpoint
        // routinely has more than one parked at a time (a chat can hold a
        // question and a plan card at once). A notification that carries none
        // is therefore unactionable — cancelling all of them on a guess would
        // close cards the agent is still waiting on.
        if (requestId === undefined) {
          return;
        }
        this.cancelCall(runId, caller, requestId);
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Composed per request from what this node can actually DO rather than
      // fixed: each tool decides whether it is offered (a caller node has
      // callees to reach, a chat on a CLI that cannot ask its user anything
      // has a question to put). A node with neither is a node that should not
      // have been handed an endpoint at all, and an empty list says so
      // honestly.
      const context = { runId, nodeId, conversationId };
      return { tools: this.tools.flatMap((tool) => tool.list(context)) };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const tool = this.tools.find((entry) => entry.handles(name));
      if (tool === undefined) {
        const envelope: CallEnvelope = {
          status: 'error',
          error: `UNKNOWN_TOOL: '${name}' — this endpoint serves whatever tools/list reported for this node`,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(envelope) }],
          isError: true,
        };
      }
      const context: McpCallContext = {
        runId,
        nodeId,
        conversationId,
        caller,
        requestId: extra.requestId,
        gone,
        remote,
        whileCancellable: (call) =>
          this.whileCancellable(runId, caller, extra.requestId, call),
      };
      return tool.call(name, args, context);
    });

    return server;
  }
}

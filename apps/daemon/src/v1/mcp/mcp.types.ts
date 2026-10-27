import type { RequestId } from '@modelcontextprotocol/sdk/types.js';

/**
 * One row of a `tools/list` answer — what a model reads about a tool.
 *
 * Key order is part of the wire: the listing is serialized as built, so a
 * tool writes `name`, `description`, `inputSchema` and then (only the call
 * tools) `_meta`, in that order.
 */
export type McpToolListing = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

/**
 * What one `tools/call` answers: the text the agent reads back.
 *
 * A type alias rather than an interface, like {@link McpToolListing}: the SDK
 * types a handler's result with an index signature, which an interface never
 * satisfies.
 */
export type McpToolResult = {
  content: { type: 'text'; text: string }[];
  isError: boolean;
};

/** WHO a listing is for: one node of one run, in one of its conversations. */
export interface McpListContext {
  runId: string;
  nodeId: string;
  /**
   * The callee conversation the asking process speaks in — the endpoint's
   * last segment — or null for the node's own. Non-null means the asker is
   * answering a call, which changes what some tools tell it.
   */
  conversationId: string | null;
}

/**
 * WHO is calling, and the two seams a call that WAITS needs.
 *
 * Built per request by `McpServerService`, which owns both seams: the
 * cancellation map outlives the stateless SDK server a request is answered on,
 * so no tool could keep it itself.
 */
export interface McpCallContext extends McpListContext {
  /**
   * The caller key (`callerKey(nodeId, conversationId)`) — a CONVERSATION,
   * not a node, for the call tools' ownership rules.
   */
  caller: string;
  /** The JSON-RPC id of this call, as the client numbered it. */
  requestId: RequestId;
  /**
   * Trips when the HTTP request being served goes away. Absent for a server
   * built outside a request (a test).
   */
  gone?: AbortSignal;
  /**
   * True when the LAN gateway proxied this request from a paired device
   * (`auth/remote-marker.ts`). A tool that acts with the Mac user's own
   * logins (sharing a page) refuses on it.
   */
  remote: boolean;
  /**
   * Run a PARKING call under a signal the client's own
   * `notifications/cancelled` for this request can trip. Only a tool that
   * waits — on a person, on a callee, or on downloads (`show_gallery`) — needs
   * it.
   */
  whileCancellable<TOutcome>(
    call: (signal: AbortSignal) => Promise<TOutcome>,
  ): Promise<TOutcome>;
}

/**
 * The contract every entry on geniro's MCP endpoint meets.
 *
 * An ENTRY rather than a tool, because one entry may serve several names: the
 * board tools are written by the tasks module and offered through one entry
 * (`tools/board/board.tools.ts`). Every tool geniro writes itself is one name,
 * and extends the shared base, `BaseMcpTool`.
 */
export interface McpTool {
  /** Whether a `tools/call` of this name is this entry's to answer. */
  handles(name: string): boolean;
  /** What this entry offers one node right now — empty when nothing. */
  list(context: McpListContext): McpToolListing[];
  /** Answer one call. Never throws: a refusal is an answer the agent reads. */
  call(
    name: string,
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult>;
}

/**
 * A tool's arguments as its reader found them: the query it asks, or the
 * reason it cannot be read — answered as INVALID_ARGS.
 */
export type ToolArgs<TQuery> =
  { ok: true; query: TQuery } | { ok: false; error: string };

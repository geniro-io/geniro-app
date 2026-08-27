import {
  CLAUDE_MCP_NOT_CONNECTED_PATTERN,
  CLAUDE_MCP_RECONNECT_SUBTYPE,
} from '../claude.const';

/**
 * Reading and writing the `mcp_reconnect` control dialogue — the repair for a
 * server that dialled and DIED, which the readiness gate beside it cannot help
 * with (it waits for `pending` to clear, and a failed server has cleared it).
 *
 * Pure by design, exactly like `claude-mcp-ready.utils.ts`: the attempt's state
 * lives on the per-turn driver, and everything here is the wire shape it reads,
 * so a spec exercises both with no process. The WHY and the probe evidence live
 * at {@link CLAUDE_MCP_RECONNECT_SUBTYPE} in `claude.const.ts`.
 */

/** What one reconnect attempt came back as. */
export interface ClaudeMcpReconnectReply {
  /** The CLI's own reason, or null when it reported success. */
  error: string | null;
}

/** The `mcp_reconnect` request line, newline-terminated for the dialogue. */
export function mcpReconnectRequestLine(
  requestId: string,
  serverName: string,
): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: CLAUDE_MCP_RECONNECT_SUBTYPE, serverName },
  })}\n`;
}

/**
 * What one parsed stdout line says about the attempt `requestId` is waiting on,
 * or null when the line is about something else entirely.
 *
 * Both outcomes are a reply: a refusal is as much an answer as a success here,
 * unlike the readiness poll, whose 'refused' means "there is no oracle" and has
 * to be told apart from a reading. There is nothing to keep waiting for either
 * way, so the two collapse into one shape carrying the reason or null.
 */
export function readMcpReconnectReply(
  obj: unknown,
  requestId: string,
): ClaudeMcpReconnectReply | null {
  if (typeof obj !== 'object' || obj === null) {
    return null;
  }
  const line = obj as { type?: unknown; response?: unknown };
  if (line.type !== 'control_response') {
    return null;
  }
  const envelope = line.response;
  if (typeof envelope !== 'object' || envelope === null) {
    return null;
  }
  const reply = envelope as {
    subtype?: unknown;
    request_id?: unknown;
    error?: unknown;
  };
  if (reply.request_id !== requestId) {
    return null;
  }
  if (reply.subtype === 'success') {
    return { error: null };
  }
  // A reply that failed without saying why still has to be distinguishable from
  // one that succeeded, so the reason falls back to the subtype rather than to
  // null — null is the SUCCESS signal here.
  const error =
    typeof reply.error === 'string' && reply.error.trim().length > 0
      ? reply.error.trim()
      : String(reply.subtype);
  return { error };
}

/**
 * The server named by a tool result that failed because it is not connected, or
 * null for every other line.
 *
 * Matched against the WHOLE trimmed leaf rather than searched within it — see
 * {@link CLAUDE_MCP_NOT_CONNECTED_PATTERN} for the substring match that made
 * `isPermissionChannelFailure` fire on geniro's own source being read back.
 *
 * `is_error` is required as well as the sentence: the text is short enough for
 * an agent to quote in a file it writes, and a quoted sentence inside a
 * successful `Read` is not a server going down.
 */
export function notConnectedMcpServer(obj: unknown): string | null {
  const root = asRecord(obj);
  if (root === null || root.type !== 'user') {
    return null;
  }
  const message = asRecord(root.message);
  const content = message?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  for (const block of content) {
    const b = asRecord(block);
    if (b === null || b.type !== 'tool_result' || b.is_error !== true) {
      continue;
    }
    const server = serverFromResult(b.content);
    if (server !== null) {
      return server;
    }
  }
  return null;
}

/** The sentence can be the whole result, or the text of one of its leaves. */
function serverFromResult(content: unknown): string | null {
  if (typeof content === 'string') {
    return matchServer(content);
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      const text = asRecord(block)?.text;
      const server = typeof text === 'string' ? matchServer(text) : null;
      if (server !== null) {
        return server;
      }
    }
    return null;
  }
  const text = asRecord(content)?.text;
  return typeof text === 'string' ? matchServer(text) : null;
}

function matchServer(text: string): string | null {
  const matched = CLAUDE_MCP_NOT_CONNECTED_PATTERN.exec(text.trim());
  return matched?.[1] ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

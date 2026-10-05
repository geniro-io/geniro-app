import {
  CLAUDE_HOOK_RESPONSE_SUBTYPE,
  CLAUDE_HOOK_STARTED_SUBTYPE,
  CLAUDE_MCP_STATUS_PENDING,
  CLAUDE_MCP_STATUS_ROWS_KEY,
  CLAUDE_MCP_STATUS_SUBTYPE,
} from '../claude.const';

/**
 * Reading and writing the `mcp_status` control dialogue — the oracle the
 * readiness gate polls before a session's first prompt goes out.
 *
 * Pure by design: the gate's state machine lives on the per-turn driver (one
 * adapter instance drives N concurrent turns), and everything here is the wire
 * shape it reads, so a spec can exercise both without a process. The WHY, the
 * probe evidence and the expiry warning all live at
 * {@link CLAUDE_MCP_STATUS_SUBTYPE} in `claude.const.ts`.
 */

/** One MCP server as the CLI reports it on this dialogue. */
export interface ClaudeMcpStatusRow {
  name: string;
  status: string;
}

/** The `mcp_status` request line, newline-terminated for the stdin dialogue. */
export function mcpStatusRequestLine(requestId: string): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: CLAUDE_MCP_STATUS_SUBTYPE },
  })}\n`;
}

/**
 * What one parsed stdout line says about the poll `requestId` is waiting on.
 *
 * - rows      — a successful reading (possibly empty: discovery is not done)
 * - 'refused' — this CLI answered but will not do it; there is no oracle here
 * - null      — not this poll's reply at all; the caller keeps waiting
 *
 * The three are deliberately distinct because they mean opposite things to the
 * gate: an empty reading is "wait, we do not know yet", a refusal is "stop
 * waiting, we will never know", and null is "this line was about something
 * else". Collapsing the first two would hold every turn for the full grace on a
 * CLI that cannot answer at all.
 */
export function readMcpStatusReply(
  obj: unknown,
  requestId: string,
): ClaudeMcpStatusRow[] | 'refused' | null {
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
    response?: unknown;
  };
  if (reply.request_id !== requestId) {
    return null;
  }
  if (reply.subtype !== 'success') {
    return 'refused';
  }
  const body = reply.response;
  if (typeof body !== 'object' || body === null) {
    return 'refused';
  }
  const rows = (body as Record<string, unknown>)[CLAUDE_MCP_STATUS_ROWS_KEY];
  if (!Array.isArray(rows)) {
    return 'refused';
  }
  return rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null) {
      return [];
    }
    const { name, status } = row as { name?: unknown; status?: unknown };
    return typeof name === 'string' && typeof status === 'string'
      ? [{ name, status }]
      : [];
  });
}

/** The servers still dialling, by name. */
export function pendingMcpServers(
  rows: readonly ClaudeMcpStatusRow[],
): string[] {
  return rows
    .filter((row) => row.status === CLAUDE_MCP_STATUS_PENDING)
    .map((row) => row.name);
}

/**
 * A comparable fingerprint of one reading, for "has anything moved since the
 * last poll".
 *
 * Sorted, because the reply's own order is not stable, and it carries the
 * STATUS as well as the name: the set of servers both grows and changes during
 * discovery (measured, a `dynamic`-scope plugin row present at 0.8s was absent
 * at 1.2s), so a name-only key would call two genuinely different readings the
 * same and release the prompt mid-discovery.
 */
export function mcpReadingKey(rows: readonly ClaudeMcpStatusRow[]): string {
  return rows
    .map((row) => `${row.name}\u0000${row.status}`)
    .sort()
    .join('\u0001');
}

/** One of the CLI's hooks starting or finishing, by the id that pairs the two. */
export interface ClaudeHookSignal {
  hookId: string;
  running: boolean;
}

/**
 * What one parsed stdout line says about the CLI's own hooks — null for any
 * other line, and for a hook line without an id to pair it by.
 *
 * The gate reads these because a hook running is WHY the CLI is not answering
 * its polls (see {@link CLAUDE_HOOK_STARTED_SUBTYPE}).
 */
export function readHookSignal(obj: unknown): ClaudeHookSignal | null {
  if (typeof obj !== 'object' || obj === null) {
    return null;
  }
  const line = obj as { type?: unknown; subtype?: unknown; hook_id?: unknown };
  if (line.type !== 'system' || typeof line.hook_id !== 'string') {
    return null;
  }
  if (line.subtype === CLAUDE_HOOK_STARTED_SUBTYPE) {
    return { hookId: line.hook_id, running: true };
  }
  if (line.subtype === CLAUDE_HOOK_RESPONSE_SUBTYPE) {
    return { hookId: line.hook_id, running: false };
  }
  return null;
}

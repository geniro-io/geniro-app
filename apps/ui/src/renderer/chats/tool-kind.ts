/**
 * What KIND of work a tool call is, in the one vocabulary shared by every agent.
 *
 * TWIN PARSER: `apps/daemon/src/v1/agents/utils/event-to-item.ts` stamps the
 * `toolKind` key this reads, from the `tool_call` event's own `kind` — ACP's
 * `ToolKind`, which an ACP agent sends on the wire. An item payload is
 * `z.unknown()` on the wire BY DESIGN — every item kind carries a different
 * shape — so no generated type reaches the renderer and the two sides are
 * independent readings of one shape. Rename the key there and this file must
 * change with it.
 *
 * It exists because the group summary used to bucket on one CLI's tool NAMES
 * (`Read`, `Edit`, `Bash`) and on an `input.file_path`. A cursor turn has
 * neither — its calls are titled "Read File", "Edit File", "grep" and disclose no
 * arguments — so a turn that read a file, edited it and ran a command summarised
 * as "Used 2 tools" and named nothing it had done.
 */

/**
 * ACP's `ToolKind` members, as the daemon forwards them. Only the ones the
 * summary can SAY are listed; anything else (`switch_mode`, `think`, `other`, or
 * a member a later protocol version adds) reads as null and is counted as an
 * unnamed call, which is the honest answer for work this cannot describe.
 */
const NAMED_KINDS = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'fetch',
]);

export type ToolKind =
  'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch';

/** Read a tool call's kind off its payload, or null when it carries none. */
export function toolKindOf(payload: unknown): ToolKind | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const value = (payload as { toolKind?: unknown }).toolKind;
  return typeof value === 'string' && NAMED_KINDS.has(value)
    ? (value as ToolKind)
    : null;
}

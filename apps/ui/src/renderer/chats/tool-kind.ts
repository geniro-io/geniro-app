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

// ── The name buckets ───────────────────────────────────────────────────────────
// One CLI's tool VOCABULARY, for the agents that classify nothing (claude sends
// no `toolKind`). Consulted only after {@link toolKindOf} draws a blank, so an
// agent's own answer always wins.

/** File-touching tools. */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);
/** Tools that OPEN a named file. */
const READ_TOOLS = new Set(['Read', 'NotebookRead']);
/** Tools that look through the tree without naming one file up front. */
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
/** Tools that leave the machine. */
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
/**
 * Tools that hand a slice of the work to another agent.
 *
 * Exported because `transcript-groups` needs the same set to find the launching
 * call of each sub-agent block. Two copies of it is how a CLI renaming `Task`
 * comes to be handled in the summary and missed by the fold.
 */
export const AGENT_TOOLS = new Set(['Task', 'Agent']);
/** Every MCP tool a CLI exposes is named `mcp__<server>__<tool>`. */
const MCP_TOOL_PREFIX = 'mcp__';

/**
 * What a tool call DOES — the union {@link ToolKind} plus the three operations
 * only a tool NAME can reveal.
 *
 * `create` is not an ACP kind: the protocol folds writing a new file into
 * `edit`, while claude has a distinct `Write`, and the summary has always
 * counted "created" separately from "edited". `delegate` and `mcp` are not
 * either — one is a CLI's in-process sub-agent, the other is any server tool at
 * all, and ACP describes neither.
 */
export type ToolOperation = ToolKind | 'create' | 'delegate' | 'mcp';

/**
 * What one tool call DID, in the one vocabulary — the agent's OWN classification
 * when it made one, else read off the tool's name.
 *
 * The single classifier, and that is the whole point of it existing. The group
 * summary needs it to say "read 4 files · ran 3 commands"; the per-call row needs
 * it to draw an operation glyph instead of the same green check on every line.
 * Written twice, adding a tool to `EDIT_TOOLS` would fix one and silently miss
 * the other — and the miss is invisible, because both fall back to something
 * plausible ("Used N tools", a check).
 *
 * Deliberately says nothing about whether the call named a TARGET. That is the
 * summary's own question — it counts distinct paths, so a `Read` with no
 * `file_path` cannot be counted as a file — and answering it here would make an
 * unpaintable row indistinguishable from a call this cannot classify at all.
 */
export function toolOperationOf(payload: unknown): ToolOperation | null {
  const kind = toolKindOf(payload);
  if (kind !== null) {
    return kind;
  }
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const name = (payload as { name?: unknown }).name;
  if (typeof name !== 'string' || name === '') {
    return null;
  }
  if (name === 'Bash') {
    return 'execute';
  }
  if (name === 'Write') {
    return 'create';
  }
  if (READ_TOOLS.has(name)) {
    return 'read';
  }
  if (EDIT_TOOLS.has(name)) {
    return 'edit';
  }
  if (SEARCH_TOOLS.has(name)) {
    return 'search';
  }
  if (WEB_TOOLS.has(name)) {
    return 'fetch';
  }
  if (AGENT_TOOLS.has(name)) {
    return 'delegate';
  }
  // LAST, so an MCP server's own `Read` — `mcp__fs__Read` does not match
  // READ_TOOLS, but a server could expose a bare name that does — is only
  // treated as an MCP call when nothing more specific matched.
  if (name.startsWith(MCP_TOOL_PREFIX)) {
    return 'mcp';
  }
  return null;
}

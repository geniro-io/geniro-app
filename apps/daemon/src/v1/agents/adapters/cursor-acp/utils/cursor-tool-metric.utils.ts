import type { ToolCallMetric } from '../../adapter.types';

/** cursor's title for an MCP tool call: `<server>-<tool>: <tool>`. */
const CURSOR_MCP_TITLE = /^(.+)-([^\s:]+): \2$/;

/**
 * A cursor tool call as the tool ledger counts it. ACP gives cursor's calls a
 * human title and no machine name, so a call is counted by its ACP `kind`
 * (`read`, `edit`, `execute`, …) — a shell call is titled with the command
 * itself and an edit with the file's path, which would make every call a tool
 * of its own. The one exception is an MCP call, whose title cursor formats as
 * `<server>-<tool>: <tool>` (measured on 2026.08.11-e8db854 and read out of
 * 2026.09.10-fd3934a's `formatOperation`, as `isHostToolCall` records).
 */
export function cursorToolCallMetric(
  name: string,
  kind: string | null,
): ToolCallMetric {
  const mcp = CURSOR_MCP_TITLE.exec(name);
  if (mcp !== null) {
    return { tool: mcp[2]!, server: mcp[1]! };
  }
  return { tool: kind ?? 'other', server: null };
}

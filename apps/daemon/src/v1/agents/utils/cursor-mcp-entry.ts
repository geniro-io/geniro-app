/**
 * The one `.cursor/mcp.json` server entry geniro ever writes — shared by the
 * MCP-trust probe (temp cwd it owns) and the per-turn merge into a user's
 * worktree file, so the probe exercises byte-for-byte the shape real turns
 * get. The key is namespaced (`geniro`) and matches the claude `--mcp-config`
 * server name from M2, so call tools present identically across both CLIs.
 */

/** The mcpServers key geniro owns; a foreign entry under it is a conflict. */
export const GENIRO_MCP_SERVER_KEY = 'geniro';

/** Tool names the run endpoint serves — the entry auto-approves exactly these. */
export const GENIRO_MCP_CALL_TOOLS = [
  'call_agent',
  'await_agent',
  'answer_agent',
] as const;

export interface CursorMcpServerEntry {
  url: string;
  headers: Record<string, string>;
  /**
   * Headless cursor-agent silently drops MCP tools that are not approved;
   * scoping auto-approval to OUR tool names (never `--approve-mcps`, which
   * would blanket-approve the user's other servers too) keeps the trust
   * expansion bounded to what geniro itself serves.
   */
  autoApprove: string[];
}

export function buildCursorMcpServerEntry(
  endpoint: { url: string; token: string },
  autoApprove: readonly string[] = GENIRO_MCP_CALL_TOOLS,
): CursorMcpServerEntry {
  return {
    url: endpoint.url,
    headers: { Authorization: `Bearer ${endpoint.token}` },
    autoApprove: [...autoApprove],
  };
}

import { GENIRO_MCP_CALL_TOOLS } from '../../adapter.types';
import type { CursorMcpServerEntry } from '../cursor.types';

/**
 * The one `.cursor/mcp.json` server entry geniro ever writes — shared by the
 * MCP-trust probe (temp cwd it owns) and the per-turn merge into a user's
 * worktree file, so the probe exercises byte-for-byte the shape real turns
 * get. The key it is written under is geniro's own (`GENIRO_MCP_SERVER_KEY`
 * in `adapter.types.ts`) and is the same one the claude `--mcp-config` file
 * uses, so call tools present identically across both CLIs.
 */
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

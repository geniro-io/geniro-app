import type { AgentMcpServerHealth } from '../../adapter.types';
import {
  CURSOR_MCP_TOOLS_AUTH_MARKER,
  CURSOR_MCP_TOOLS_FAILED_MARKER,
  CURSOR_MCP_TOOLS_READY_MARKER,
} from '../cursor-acp.const';

/**
 * Read one server's health out of `cursor-agent mcp list-tools <server>`.
 *
 * MARKER-BASED, not exit-code-based, and that is forced rather than chosen: the
 * two failure readings this exists to tell apart share an exit status of 1, and
 * both are written to stderr. The caller therefore hands over stdout AND stderr
 * whatever the exit (`AgentCommandOptions.captureDiagnosis`), and the wording is
 * the only thing left that separates them.
 *
 * Null for output that matches nothing, which keeps the two ways of not knowing
 * distinct: "the CLI said this server needs signing in" and "the CLI said
 * something this parser has never seen" must not both arrive as a status, or a
 * reworded release would silently start reporting every server as broken. The
 * caller leaves the row's health unstated instead.
 *
 * Never throws.
 */
export function parseCursorToolsProbe(
  output: string | null,
): AgentMcpServerHealth | null {
  if (!output) {
    return null;
  }
  // Order matters only in that the ready marker is checked first: it is the one
  // that appears on the SUCCESS path, where neither failure marker can occur.
  if (output.includes(CURSOR_MCP_TOOLS_READY_MARKER)) {
    return { status: 'connected', detail: null };
  }
  if (output.includes(CURSOR_MCP_TOOLS_AUTH_MARKER)) {
    // No detail: the CLI's own next line is `Please run: agent mcp login <name>`,
    // which is advice the panel already renders as a Sign in button. Repeating
    // it as row text would tell the user to open a terminal for something they
    // can press.
    return { status: 'needs_auth', detail: null };
  }
  if (output.includes(CURSOR_MCP_TOOLS_FAILED_MARKER)) {
    return { status: 'failed', detail: firstLine(output) };
  }
  return null;
}

/**
 * The first non-empty line, which is where this CLI puts the reason.
 *
 * Trimmed to one line deliberately: a Streamable-HTTP failure carries the
 * remote's entire HTML error page, and the panel renders `detail` verbatim.
 */
function firstLine(output: string): string | null {
  const line = output
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line !== undefined && line.length > 0 ? line : null;
}

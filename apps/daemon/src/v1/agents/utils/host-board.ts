import { HOST_BOARD_TOOLS, type HostBoardTool } from '../chat.types';
import { isHostToolCall } from './host-tool';

/** Whether a name is one of the board tools geniro's MCP server serves. */
export function isHostBoardTool(name: string): name is HostBoardTool {
  return (HOST_BOARD_TOOLS as readonly string[]).includes(name);
}

/** Whether a tool call is one of geniro's own board tools on this run's server. */
export function isHostBoardCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return HOST_BOARD_TOOLS.some((tool) =>
    isHostToolCall(serverName, toolName, tool),
  );
}

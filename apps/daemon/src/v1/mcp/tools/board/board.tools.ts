import { isHostBoardTool } from '../../../agents/utils/host-board';
import type { TaskBoardBroker } from '../../../graphs/services/task-board.broker';
import type {
  McpCallContext,
  McpTool,
  McpToolListing,
  McpToolResult,
} from '../../mcp.types';

/**
 * The BOARD tools (`HOST_BOARD_TOOLS`), served as one entry.
 *
 * The one entry that is not a `BaseMcpTool`, because geniro's MCP host does
 * not write these: the tasks module owns their names, descriptions and
 * schemas (`tasks/utils/board-tools.ts`) and installs them behind
 * {@link TaskBoardBroker}, since this module may not import that one. So
 * there is no instructions or schema file here — this entry only lists what
 * the broker offers and dispatches by name.
 *
 * Offered to every agent holding this endpoint — not only one whose run works
 * a card — so any chat can file and read cards without learning the daemon's
 * REST API.
 */
export class BoardTools implements McpTool {
  constructor(private readonly board: TaskBoardBroker) {}

  handles(name: string): boolean {
    return isHostBoardTool(name);
  }

  list(): McpToolListing[] {
    return [...this.board.tools()];
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    { runId }: McpCallContext,
  ): Promise<McpToolResult> {
    const answer = await this.board.call(runId, name, args);
    return {
      content: [{ type: 'text', text: answer.text }],
      isError: answer.isError,
    };
  }
}

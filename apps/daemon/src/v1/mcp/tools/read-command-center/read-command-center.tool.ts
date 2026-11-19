import { HOST_READ_COMMAND_CENTER_TOOL } from '../../../agents/chat.types';
import type { CommandCenterBroker } from '../../../agents/services/command-center.broker';
import type { CommandCenterOpsBroker } from '../../../agents/services/command-center-ops.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { readCommandCenterInstructions } from './read-command-center.instructions';
import {
  readCommandCenterResultText,
  readReadCommandCenterArgs,
} from './read-command-center.reader';
import { readCommandCenterSchema } from './read-command-center.schema';

/**
 * `read_command_center` — offered only on a command-center manager turn.
 * `tools/call` skips `isOffered`, so the command center refuses any other run
 * from its row.
 */
export class ReadCommandCenterTool extends BaseMcpTool {
  readonly name = HOST_READ_COMMAND_CENTER_TOOL;

  constructor(
    private readonly managers: CommandCenterBroker,
    private readonly ops: CommandCenterOpsBroker,
  ) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.managers.canManage(runId, memberId);
  }

  protected instructions(): string {
    return readCommandCenterInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return readCommandCenterSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId }: McpCallContext,
  ): Promise<McpToolResult> {
    const read = readReadCommandCenterArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const answer = await this.ops.read(runId);
    return 'error' in answer
      ? this.text(answer.error, true)
      : this.text(readCommandCenterResultText(answer));
  }
}

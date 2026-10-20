import { HOST_REMOVE_ACTION_TOOL } from '../../../agents/chat.types';
import type { ActionBroker } from '../../../agents/services/action.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { removeActionInstructions } from './remove-action.instructions';
import {
  readRemoveAction,
  removeActionResultText,
} from './remove-action.reader';
import { removeActionSchema } from './remove-action.schema';

/** `remove_action` — take back a button this conversation published. */
export class RemoveActionTool extends BaseMcpTool {
  readonly name = HOST_REMOVE_ACTION_TOOL;

  constructor(private readonly actions: ActionBroker) {
    super();
  }

  protected isOffered({ runId, nodeId }: McpListContext): boolean {
    return this.actions.canPublish(runId, nodeId);
  }

  protected instructions(): string {
    return removeActionInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return removeActionSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, nodeId }: McpCallContext,
  ): Promise<McpToolResult> {
    const actionId = readRemoveAction(args);
    if (typeof actionId !== 'string') {
      return this.invalidArgs(actionId.error);
    }
    const outcome = await this.actions.remove(runId, nodeId, actionId);
    return outcome.status === 'refused'
      ? this.invalidArgs(outcome.reason)
      : this.text(removeActionResultText(outcome));
  }
}

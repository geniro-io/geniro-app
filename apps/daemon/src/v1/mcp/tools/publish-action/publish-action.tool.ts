import { HOST_PUBLISH_ACTION_TOOL } from '../../../agents/chat.types';
import type { ActionBroker } from '../../../agents/services/action.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { publishActionInstructions } from './publish-action.instructions';
import {
  publishActionResultText,
  readPublishAction,
} from './publish-action.reader';
import { publishActionSchema } from './publish-action.schema';

/** `publish_action` — put a button in the chat that the user can press. */
export class PublishActionTool extends BaseMcpTool {
  readonly name = HOST_PUBLISH_ACTION_TOOL;

  constructor(private readonly actions: ActionBroker) {
    super();
  }

  protected isOffered({ runId, nodeId }: McpListContext): boolean {
    return this.actions.canPublish(runId, nodeId);
  }

  protected instructions(): string {
    return publishActionInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return publishActionSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, nodeId, caller }: McpCallContext,
  ): Promise<McpToolResult> {
    const input = readPublishAction(args);
    if ('error' in input) {
      return this.invalidArgs(input.error);
    }
    const outcome = await this.actions.publish(runId, nodeId, input, caller);
    // A refusal is the call's own fault (a cap, a character, a missing kind),
    // so it reads as one; an unavailable channel is an answer to carry on from.
    return outcome.status === 'refused'
      ? this.invalidArgs(outcome.reason)
      : this.text(publishActionResultText(outcome));
  }
}

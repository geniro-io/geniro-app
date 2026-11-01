import { HOST_NOTIFY_TOOL } from '../../../agents/chat.types';
import type { NotifyBroker } from '../../../agents/services/notify.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { notifyUserInstructions } from './notify-user.instructions';
import { hostNotifyResultText, readHostNotify } from './notify-user.reader';
import { notifyUserSchema } from './notify-user.schema';

/** `notify_user` — the agent's own notification that it is done. */
export class NotifyUserTool extends BaseMcpTool {
  readonly name = HOST_NOTIFY_TOOL;

  constructor(private readonly notices: NotifyBroker) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.notices.canNotify(runId, memberId);
  }

  protected instructions(): string {
    return notifyUserInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return notifyUserSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, memberId } = context;
    const message = readHostNotify(args);
    // A notification with nothing in it is only ever a mistake, so it is
    // answered as a malformed call rather than sent as a blank banner.
    if (message === null) {
      return this.invalidArgs("'message' must be a non-empty string.");
    }
    const outcome = await this.notices.notify(runId, memberId, message);
    // An unavailable channel is an answer, not a failure — the agent can
    // still say it in its reply.
    return this.text(hostNotifyResultText(outcome));
  }
}

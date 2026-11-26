import { HOST_FLAG_ISSUE_TOOL } from '../../../agents/chat.types';
import type { FlagBroker } from '../../../agents/services/flag.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { flagIssueInstructions } from './flag-issue.instructions';
import { flagIssueResultText, readFlagIssue } from './flag-issue.reader';
import { flagIssueSchema } from './flag-issue.schema';

/** `flag_issue` — record a problem that cost work or met the user's disagreement. */
export class FlagIssueTool extends BaseMcpTool {
  readonly name = HOST_FLAG_ISSUE_TOOL;

  constructor(private readonly flags: FlagBroker) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.flags.canUse(runId, memberId);
  }

  protected instructions(): string {
    return flagIssueInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return flagIssueSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, memberId, caller }: McpCallContext,
  ): Promise<McpToolResult> {
    const input = readFlagIssue(args);
    if ('error' in input) {
      return this.invalidArgs(input.error);
    }
    const outcome = await this.flags.raise(runId, memberId, caller, input);
    return this.answerTo(
      outcome,
      flagIssueResultText(outcome),
      outcome.status !== 'recorded',
    );
  }
}

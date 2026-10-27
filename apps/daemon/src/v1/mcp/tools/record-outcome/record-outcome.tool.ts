import { HOST_RECORD_OUTCOME_TOOL } from '../../../agents/chat.types';
import type { RunOutcomeBroker } from '../../../agents/services/run-outcome.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { recordOutcomeInstructions } from './record-outcome.instructions';
import {
  readRecordOutcome,
  recordOutcomeResultText,
} from './record-outcome.reader';
import { recordOutcomeSchema } from './record-outcome.schema';

/** `record_outcome` — record where one pull request of this workflow run stands. */
export class RecordOutcomeTool extends BaseMcpTool {
  readonly name = HOST_RECORD_OUTCOME_TOOL;

  constructor(private readonly outcomes: RunOutcomeBroker) {
    super();
  }

  protected isOffered({ runId, nodeId }: McpListContext): boolean {
    return this.outcomes.canUse(runId, nodeId);
  }

  protected instructions(): string {
    return recordOutcomeInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return recordOutcomeSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, nodeId, caller }: McpCallContext,
  ): Promise<McpToolResult> {
    const input = readRecordOutcome(args);
    if ('error' in input) {
      return this.invalidArgs(input.error);
    }
    const outcome = await this.outcomes.record(runId, nodeId, caller, input);
    return outcome.status === 'refused'
      ? this.invalidArgs(outcome.reason)
      : this.text(recordOutcomeResultText(outcome));
  }
}

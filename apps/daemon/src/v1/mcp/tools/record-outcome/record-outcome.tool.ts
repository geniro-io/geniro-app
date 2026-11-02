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
  isThreadOutcomeCall,
  readRecordOutcome,
  readThreadOutcomeCall,
  recordOutcomeResultText,
  threadOutcomeResultText,
} from './record-outcome.reader';
import { recordOutcomeSchema } from './record-outcome.schema';

/** `record_outcome` — record how this thread ended, or where one pull request of it stands. */
export class RecordOutcomeTool extends BaseMcpTool {
  readonly name = HOST_RECORD_OUTCOME_TOOL;

  constructor(private readonly outcomes: RunOutcomeBroker) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.outcomes.canUse(runId, memberId);
  }

  protected instructions(): string {
    return recordOutcomeInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return recordOutcomeSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, memberId, caller }: McpCallContext,
  ): Promise<McpToolResult> {
    if (isThreadOutcomeCall(args)) {
      const thread = readThreadOutcomeCall(args);
      if ('error' in thread) {
        return this.invalidArgs(thread.error);
      }
      const recorded = await this.outcomes.recordThread(
        runId,
        memberId,
        caller,
        thread,
      );
      return recorded.status === 'refused'
        ? this.invalidArgs(recorded.reason)
        : this.text(threadOutcomeResultText(recorded));
    }
    const input = readRecordOutcome(args);
    if ('error' in input) {
      return this.invalidArgs(input.error);
    }
    const outcome = await this.outcomes.record(runId, memberId, caller, input);
    return outcome.status === 'refused'
      ? this.invalidArgs(outcome.reason)
      : this.text(recordOutcomeResultText(outcome));
  }
}

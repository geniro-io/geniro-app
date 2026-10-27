import { HOST_MOVE_STAGE_TOOL } from '../../../agents/chat.types';
import type { CallBroker } from '../../../graphs/services/call-broker.service';
import type { StageService } from '../../../graphs/services/stage.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { moveStageInstructions } from './move-stage.instructions';
import { moveStageResultText, readMoveStage } from './move-stage.reader';
import { moveStageSchema } from './move-stage.schema';

export class MoveStageTool extends BaseMcpTool {
  readonly name = HOST_MOVE_STAGE_TOOL;

  constructor(
    private readonly stages: StageService,
    private readonly calls: CallBroker,
  ) {
    super();
  }

  protected isOffered({ runId, nodeId }: McpListContext): boolean {
    return this.stages.canUse(runId, nodeId);
  }

  protected instructions(): string {
    return moveStageInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return moveStageSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, nodeId, caller }: McpCallContext,
  ): Promise<McpToolResult> {
    const request = readMoveStage(args);
    if ('error' in request) {
      return this.invalidArgs(request.error);
    }
    try {
      const callId = this.calls.callAnsweredBy(runId, caller);
      const result = await this.stages.move(runId, request, {
        kind: 'agent',
        nodeId,
        ...(callId !== null ? { callId } : {}),
      });
      const reply = moveStageResultText(
        result,
        result.ok ? result.workflow.nodes : [],
      );
      return this.text(reply.text, reply.isError);
    } catch (error) {
      return this.text(
        `Not moved: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }
}

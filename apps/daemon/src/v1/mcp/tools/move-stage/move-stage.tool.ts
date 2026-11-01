import { Logger } from '@nestjs/common';

import { HOST_MOVE_STAGE_TOOL } from '../../../agents/chat.types';
import type { CallBroker } from '../../../teams/services/call-broker.service';
import type { StageService } from '../../../teams/services/stage.service';
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
  private readonly logger = new Logger(MoveStageTool.name);

  constructor(
    private readonly stages: StageService,
    private readonly calls: CallBroker,
  ) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.stages.canUse(runId, memberId);
  }

  protected instructions(): string {
    return moveStageInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return moveStageSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, memberId, caller }: McpCallContext,
  ): Promise<McpToolResult> {
    if (!this.stages.canUse(runId, memberId)) {
      return this.text('Not moved: this run has no stages you can move.', true);
    }
    const request = readMoveStage(args);
    if ('error' in request) {
      return this.invalidArgs(request.error);
    }
    try {
      const callId = this.calls.callAnsweredBy(runId, caller);
      const result = await this.stages.move(runId, request, {
        kind: 'agent',
        nodeId: memberId,
        ...(callId !== null ? { callId } : {}),
      });
      const reply = moveStageResultText(
        result,
        result.ok ? result.team.members : [],
      );
      return this.text(reply.text, reply.isError);
    } catch (error) {
      this.logger.error(
        `run ${runId} could not move a stage: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.text(
        'Not moved: the move could not be saved. Try again.',
        true,
      );
    }
  }
}

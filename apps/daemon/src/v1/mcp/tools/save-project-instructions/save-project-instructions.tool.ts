import { Logger } from '@nestjs/common';

import { HOST_PROJECT_INSTRUCTIONS_TOOL } from '../../../agents/chat.types';
import type { AnalysisBroker } from '../../../agents/services/analysis.broker';
import type { ProjectInstructionsBroker } from '../../../agents/services/project-instructions.broker';
import type { ProjectInstructionsChangeService } from '../../../agents/services/project-instructions-change.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { saveProjectInstructionsInstructions } from './save-project-instructions.instructions';
import {
  projectInstructionsResultText,
  readSaveProjectInstructionsArgs,
} from './save-project-instructions.reader';
import { saveProjectInstructionsSchema } from './save-project-instructions.schema';

/**
 * `save_project_instructions` — an analysis's one write to a project, for the
 * `P-` items the user applied, through `ProjectInstructionsChangeService`.
 * Offered wherever `report_recommendations` is. It parks on a card showing the
 * old and new text in every approval mode, and only that card's Apply writes.
 */
export class SaveProjectInstructionsTool extends BaseMcpTool {
  readonly name = HOST_PROJECT_INSTRUCTIONS_TOOL;
  private readonly logger = new Logger(SaveProjectInstructionsTool.name);

  constructor(
    private readonly analysis: AnalysisBroker,
    private readonly changes: ProjectInstructionsChangeService,
    private readonly cards: ProjectInstructionsBroker,
  ) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return (
      this.analysis.canAnalyse(runId, memberId) &&
      this.cards.canPropose(runId, memberId)
    );
  }

  protected instructions({ runId, memberId }: McpListContext): string {
    return saveProjectInstructionsInstructions(
      this.cards.answersAtOnce(runId, memberId),
    );
  }

  protected inputSchema(): Record<string, unknown> {
    return saveProjectInstructionsSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, memberId } = context;
    // A call is not checked against the listing, so the gate is asked again.
    if (!this.isOffered(context)) {
      return this.text(
        'Nothing saved: no analysis turn is running in this chat.',
        true,
      );
    }
    const read = readSaveProjectInstructionsArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const turn = await this.analysis.turnOf(runId, memberId);
    if ('status' in turn) {
      return this.text(`Nothing saved: ${turn.reason}.`, true);
    }
    try {
      const answer = await context.whileCancellable((signal) =>
        this.changes.save({ turn, ...read.query }, (change) =>
          this.cards.propose(runId, memberId, change, signal),
        ),
      );
      const result = projectInstructionsResultText(answer);
      return this.text(result.text, result.isError);
    } catch (error) {
      this.logger.error(
        `run ${runId} could not save project instructions: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.text(
        `${this.name} failed internally — nothing was saved. Report this item as failed.`,
        true,
      );
    }
  }
}

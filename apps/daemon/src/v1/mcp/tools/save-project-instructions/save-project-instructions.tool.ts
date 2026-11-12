import { Logger } from '@nestjs/common';

import { HOST_PROJECT_INSTRUCTIONS_TOOL } from '../../../agents/chat.types';
import type { AnalysisBroker } from '../../../agents/services/analysis.broker';
import type { ProjectChatBroker } from '../../../agents/services/project-chat.broker';
import type { ProjectInstructionsBroker } from '../../../agents/services/project-instructions.broker';
import type { ProjectInstructionsChangeService } from '../../../agents/services/project-instructions-change.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import {
  ordinaryChatInstructionsInstructions,
  projectChatInstructionsInstructions,
  saveProjectInstructionsInstructions,
} from './save-project-instructions.instructions';
import {
  type OrdinaryChatInstructionsArgs,
  projectInstructionsResultText,
  readOrdinaryChatInstructionsArgs,
  readProjectChatInstructionsArgs,
  readSaveProjectInstructionsArgs,
} from './save-project-instructions.reader';
import {
  type ProjectInstructionsAudience,
  saveProjectInstructionsSchema,
} from './save-project-instructions.schema';

/**
 * `save_project_instructions` — any chat's write to any project, through
 * `ProjectInstructionsChangeService`: a project chat's own project when it names
 * none, and an analysis's write of the `P-` items the user applied when it names
 * those. It parks on a card showing the old and new text in every approval mode,
 * and only that card's Apply writes.
 */
export class SaveProjectInstructionsTool extends BaseMcpTool {
  readonly name = HOST_PROJECT_INSTRUCTIONS_TOOL;
  private readonly logger = new Logger(SaveProjectInstructionsTool.name);

  constructor(
    private readonly analysis: AnalysisBroker,
    private readonly projectChats: ProjectChatBroker,
    private readonly changes: ProjectInstructionsChangeService,
    private readonly cards: ProjectInstructionsBroker,
  ) {
    super();
  }

  protected isOffered({
    runId,
    memberId,
    conversationId,
  }: McpListContext): boolean {
    return this.cards.canPropose(runId, memberId, conversationId);
  }

  private audienceOf(
    runId: string,
    memberId: string,
  ): ProjectInstructionsAudience {
    if (this.projectChats.canEdit(runId, memberId)) {
      return 'project';
    }
    return this.analysis.canAnalyse(runId, memberId) ? 'analysis' : 'chat';
  }

  protected instructions({ runId, memberId }: McpListContext): string {
    const answersAtOnce = this.cards.answersAtOnce(runId, memberId);
    switch (this.audienceOf(runId, memberId)) {
      case 'project':
        return projectChatInstructionsInstructions(answersAtOnce);
      case 'chat':
        return ordinaryChatInstructionsInstructions(answersAtOnce);
      case 'analysis':
        return saveProjectInstructionsInstructions(answersAtOnce);
    }
  }

  protected inputSchema({
    runId,
    memberId,
  }: McpListContext): Record<string, unknown> {
    return saveProjectInstructionsSchema(this.audienceOf(runId, memberId));
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, memberId } = context;
    // A call is not checked against the listing, so the gate is asked again.
    if (!this.isOffered(context)) {
      return this.text(
        'Nothing saved: project instructions are changed from a chat or by the lead of a team run in its own conversation, and no such turn is running here.',
        true,
      );
    }
    const projectChat = this.projectChats.projectOf(runId, memberId);
    if (projectChat !== null) {
      const read = readProjectChatInstructionsArgs(args);
      return read.ok
        ? this.saveForChat(context, {
            ...read.query,
            projectId: read.query.projectId ?? projectChat.projectId,
          })
        : this.invalidArgs(read.error);
    }
    if (!this.analysis.canAnalyse(runId, memberId)) {
      const read = readOrdinaryChatInstructionsArgs(args);
      return read.ok
        ? this.saveForChat(context, read.query)
        : this.invalidArgs(read.error);
    }
    const read = readSaveProjectInstructionsArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const { ids, ...change } = read.query;
    if (ids === undefined) {
      return this.saveForChat(context, change);
    }
    const turn = await this.analysis.turnOf(runId, memberId);
    if ('status' in turn) {
      return this.text(`Nothing saved: ${turn.reason}.`, true);
    }
    try {
      const answer = await context.whileCancellable((signal) =>
        this.changes.save({ turn, ...change, ids }, (card) =>
          this.cards.propose(runId, memberId, card, signal),
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

  private async saveForChat(
    context: McpCallContext,
    change: OrdinaryChatInstructionsArgs,
  ): Promise<McpToolResult> {
    const { runId, memberId } = context;
    try {
      const answer = await context.whileCancellable((signal) =>
        this.changes.saveForChat({ chatRunId: runId, ...change }, (card) =>
          this.cards.propose(runId, memberId, card, signal),
        ),
      );
      const result = projectInstructionsResultText(answer);
      return this.text(result.text, result.isError);
    } catch (error) {
      this.logger.error(
        `chat ${runId} could not save project instructions: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.text(
        `${this.name} failed internally — nothing was saved.`,
        true,
      );
    }
  }
}

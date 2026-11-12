import { Logger } from '@nestjs/common';

import {
  type GoalActor,
  type GoalsWriteOutcome,
  HOST_GOALS_TOOL,
} from '../../../agents/chat.types';
import type { GoalWritersBroker } from '../../../agents/services/goal-writers.broker';
import type { GoalsService } from '../../../agents/services/goals.service';
import { ALWAYS_LOADED_TOOL_META } from '../../../teams/teams.types';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { goalsInstructions } from './goals.instructions';
import {
  type GoalsCall,
  goalsLeadOnlyText,
  goalsListText,
  goalsResultText,
  readGoals,
} from './goals.reader';
import { goalsSchema } from './goals.schema';

/**
 * `goals` — record a task's goals and close each with evidence. Offered in
 * every run; in a team run only the lead writes them (`GoalWritersBroker`).
 */
export class GoalsTool extends BaseMcpTool {
  readonly name = HOST_GOALS_TOOL;
  protected readonly meta: Record<string, unknown> | null =
    ALWAYS_LOADED_TOOL_META;
  private readonly logger = new Logger(GoalsTool.name);

  constructor(
    private readonly goals: GoalsService,
    private readonly writers: GoalWritersBroker,
  ) {
    super();
  }

  protected isOffered(): boolean {
    return true;
  }

  protected instructions({ runId, memberId }: McpListContext): string {
    return goalsInstructions(this.writers.isTeamMember(runId, memberId));
  }

  protected inputSchema(): Record<string, unknown> {
    return goalsSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, memberId } = context;
    const call = readGoals(args);
    if ('error' in call) {
      return this.invalidArgs(call.error);
    }
    const actor: GoalActor = { kind: 'agent', memberId };
    try {
      if (call.action === 'list') {
        const goals = await this.goals.list(runId);
        if (goals === null) {
          return this.text('This run no longer exists.', true);
        }
        return this.text(
          goalsListText(
            goals,
            goals.length > 0 || (await this.mayWrite(context)),
          ),
        );
      }
      if (!(await this.mayWrite(context))) {
        return this.text(goalsLeadOnlyText(), true);
      }
      const outcome = await this.write(runId, actor, call);
      const reply = goalsResultText(call.action, outcome);
      return this.text(reply.text, reply.isError);
    } catch (error) {
      this.logger.error(
        `run ${runId} could not ${call.action} its goals: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.text('Not changed: the goals could not be written.', true);
    }
  }

  private async mayWrite({
    runId,
    memberId,
    conversationId,
  }: McpCallContext): Promise<boolean> {
    return (
      this.writers.canWrite(runId, memberId, conversationId) ||
      !(await this.goals.isTeamRun(runId))
    );
  }

  private write(
    runId: string,
    actor: GoalActor,
    call: Exclude<GoalsCall, { action: 'list' }>,
  ): Promise<GoalsWriteOutcome> {
    switch (call.action) {
      case 'set':
        return this.goals.set(runId, actor, call.goals);
      case 'add':
        return this.goals.add(runId, actor, call.goals);
      case 'update':
        return this.goals.update(runId, actor, call.id, call.text);
      case 'remove':
        return this.goals.remove(runId, actor, call.id);
      case 'complete':
        return this.goals.close(
          runId,
          actor,
          call.id,
          call.status,
          call.evidence,
        );
      case 'reopen':
        return this.goals.reopen(runId, actor, call.id);
    }
  }
}

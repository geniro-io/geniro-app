import type { AnalysisBroker } from '../../agents/services/analysis.broker';
import type { ProjectChatBroker } from '../../agents/services/project-chat.broker';
import type { TeamBuilderBroker } from '../../agents/services/team-builder.broker';
import type { McpListContext } from '../mcp.types';

/** The brokers that say a turn belongs to the app's own analysis, builder or project chat. */
export interface ThreadToolGates {
  analysis: AnalysisBroker;
  teamBuilders: TeamBuilderBroker;
  projectChats: ProjectChatBroker;
}

/** Whether a turn is offered the tools that reach other threads. */
export function offersThreadTools(
  gates: ThreadToolGates,
  { runId, memberId }: McpListContext,
): boolean {
  return (
    !gates.analysis.canAnalyse(runId, memberId) &&
    !gates.teamBuilders.canEdit(runId, memberId) &&
    !gates.projectChats.canEdit(runId, memberId)
  );
}

import type { ActionBroker } from '../../agents/services/action.broker';
import type { AnalysisBroker } from '../../agents/services/analysis.broker';
import type { ArtifactBroker } from '../../agents/services/artifact.broker';
import type { ChartBroker } from '../../agents/services/chart.broker';
import type { ComparisonBroker } from '../../agents/services/comparison.broker';
import type { FindingsReportBroker } from '../../agents/services/findings-report.broker';
import type { GalleryBroker } from '../../agents/services/gallery.broker';
import type { GlobalChatSearchService } from '../../agents/services/global-chat-search.service';
import type { MetricsBroker } from '../../agents/services/metrics.broker';
import type { MonitorBroker } from '../../agents/services/monitor.broker';
import type { NotifyBroker } from '../../agents/services/notify.broker';
import type { PatchBroker } from '../../agents/services/patch.broker';
import type { PlanBroker } from '../../agents/services/plan.broker';
import type { ThreadReaderService } from '../../agents/services/thread-reader.service';
import type { UserQuestionBroker } from '../../agents/services/user-question.broker';
import type { WorkflowProposalBroker } from '../../agents/services/workflow-proposal.broker';
import type { CallBroker } from '../../graphs/services/call-broker.service';
import type { TaskBoardBroker } from '../../graphs/services/task-board.broker';
import type { WorkflowChangeService } from '../../graphs/services/workflow-change.service';
import type { WorkflowProposalService } from '../../graphs/services/workflow-proposal.service';
import type { WorkflowStoreService } from '../../graphs/services/workflow-store.service';
import type { ShareService } from '../../shares/services/share.service';
import type { McpTool } from '../mcp.types';
import { AnswerAgentTool } from './answer-agent/answer-agent.tool';
import { AskUserQuestionTool } from './ask-user-question/ask-user-question.tool';
import { AwaitAgentTool } from './await-agent/await-agent.tool';
import { BoardTools } from './board/board.tools';
import { CallAgentTool } from './call-agent/call-agent.tool';
import { CancelAgentTool } from './cancel-agent/cancel-agent.tool';
import { ListAgentThreadsTool } from './list-agent-threads/list-agent-threads.tool';
import { ListMonitorsTool } from './list-monitors/list-monitors.tool';
import { MarkRecommendationsTool } from './mark-recommendations/mark-recommendations.tool';
import { MessageAgentTool } from './message-agent/message-agent.tool';
import { MonitorTool } from './monitor/monitor.tool';
import { NotifyUserTool } from './notify-user/notify-user.tool';
import { ProposePatchTool } from './propose-patch/propose-patch.tool';
import { ProposePlanTool } from './propose-plan/propose-plan.tool';
import { ProposeWorkflowTool } from './propose-workflow/propose-workflow.tool';
import { PublishActionTool } from './publish-action/publish-action.tool';
import { ReadAnalyzedThreadTool } from './read-analyzed-thread/read-analyzed-thread.tool';
import { ReadChatContextTool } from './read-chat-context/read-chat-context.tool';
import { ReadWorkflowsTool } from './read-workflows/read-workflows.tool';
import { RemoveActionTool } from './remove-action/remove-action.tool';
import { ReportFindingsTool } from './report-findings/report-findings.tool';
import { ReportRecommendationsTool } from './report-recommendations/report-recommendations.tool';
import { SaveWorkflowChangeTool } from './save-workflow-change/save-workflow-change.tool';
import { SearchChatsTool } from './search-chats/search-chats.tool';
import { ShowArtifactTool } from './show-artifact/show-artifact.tool';
import { ShowChartTool } from './show-chart/show-chart.tool';
import { ShowComparisonTool } from './show-comparison/show-comparison.tool';
import { ShowGalleryTool } from './show-gallery/show-gallery.tool';
import { ShowMetricsTool } from './show-metrics/show-metrics.tool';
import { StopMonitorTool } from './stop-monitor/stop-monitor.tool';

/** The DI token the ordered tool list is provided under. */
export const MCP_TOOLS = Symbol('MCP_TOOLS');

/** What the tools answer through — the brokers they sit in front of. */
export interface McpToolDeps {
  calls: CallBroker;
  questions: UserQuestionBroker;
  findings: FindingsReportBroker;
  charts: ChartBroker;
  metrics: MetricsBroker;
  comparisons: ComparisonBroker;
  galleries: GalleryBroker;
  artifacts: ArtifactBroker;
  actions: ActionBroker;
  monitors: MonitorBroker;
  patches: PatchBroker;
  plans: PlanBroker;
  notices: NotifyBroker;
  board: TaskBoardBroker;
  history: GlobalChatSearchService;
  analysis: AnalysisBroker;
  threads: ThreadReaderService;
  workflowChanges: WorkflowChangeService;
  workflowGate: WorkflowProposalBroker;
  workflowStore: WorkflowStoreService;
  workflowProposals: WorkflowProposalService;
  shares: ShareService;
}

/**
 * Every tool geniro's MCP endpoint serves, in the order `tools/list` names
 * them.
 *
 * The order is part of what a model reads — the descriptions are audited as a
 * SET (`mcp-server.service.spec.ts`) — so it is written once, here: the call
 * surface, then the question, the render family, the action buttons, the
 * monitors, the board, the chat history, the workflow library, the analysis tools, and the
 * agent's own notification last.
 */
export function createMcpTools(deps: McpToolDeps): McpTool[] {
  return [
    new CallAgentTool(deps.calls),
    new AwaitAgentTool(deps.calls),
    new AnswerAgentTool(deps.calls),
    new CancelAgentTool(deps.calls),
    new MessageAgentTool(deps.calls),
    new ListAgentThreadsTool(deps.calls),
    new AskUserQuestionTool(deps.questions),
    new ReportFindingsTool(deps.findings),
    new ShowChartTool(deps.charts),
    new ShowMetricsTool(deps.metrics),
    new ShowComparisonTool(deps.comparisons),
    new ShowGalleryTool(deps.galleries),
    new ShowArtifactTool(deps.artifacts, deps.shares),
    new ProposePatchTool(deps.patches),
    new ProposePlanTool(deps.plans),
    new PublishActionTool(deps.actions),
    new RemoveActionTool(deps.actions),
    new MonitorTool(deps.monitors),
    new StopMonitorTool(deps.monitors),
    new ListMonitorsTool(deps.monitors),
    new BoardTools(deps.board),
    new SearchChatsTool(deps.history),
    new ReadChatContextTool(deps.history),
    new ReadWorkflowsTool(deps.workflowGate, deps.workflowStore),
    new ProposeWorkflowTool(deps.workflowGate, deps.workflowProposals),
    new ReadAnalyzedThreadTool(
      deps.analysis,
      deps.threads,
      deps.workflowChanges,
    ),
    new ReportRecommendationsTool(deps.analysis),
    new MarkRecommendationsTool(deps.analysis),
    new SaveWorkflowChangeTool(
      deps.analysis,
      deps.threads,
      deps.workflowChanges,
    ),
    new NotifyUserTool(deps.notices),
  ];
}

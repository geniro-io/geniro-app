import type { ActionBroker } from '../../agents/services/action.broker';
import type { AnalysisBroker } from '../../agents/services/analysis.broker';
import type { ArtifactBroker } from '../../agents/services/artifact.broker';
import type { ChartBroker } from '../../agents/services/chart.broker';
import type { ComparisonBroker } from '../../agents/services/comparison.broker';
import type { FindingsReportBroker } from '../../agents/services/findings-report.broker';
import type { GalleryBroker } from '../../agents/services/gallery.broker';
import type { GalleryImageService } from '../../agents/services/gallery-image.service';
import type { GlobalChatSearchService } from '../../agents/services/global-chat-search.service';
import type { MetricsBroker } from '../../agents/services/metrics.broker';
import type { MonitorBroker } from '../../agents/services/monitor.broker';
import type { NotifyBroker } from '../../agents/services/notify.broker';
import type { PatchBroker } from '../../agents/services/patch.broker';
import type { PlanBroker } from '../../agents/services/plan.broker';
import type { RunOutcomeBroker } from '../../agents/services/run-outcome.broker';
import type { TeamNoteBroker } from '../../agents/services/team-note.broker';
import type { ThreadReaderService } from '../../agents/services/thread-reader.service';
import type { UserQuestionBroker } from '../../agents/services/user-question.broker';
import type { WorkflowBuilderBroker } from '../../agents/services/workflow-builder.broker';
import type { WorkflowProposalBroker } from '../../agents/services/workflow-proposal.broker';
import type { CallBroker } from '../../graphs/services/call-broker.service';
import type { StageService } from '../../graphs/services/stage.service';
import type { TaskBoardBroker } from '../../graphs/services/task-board.broker';
import type { WorkflowChangeService } from '../../graphs/services/workflow-change.service';
import type { WorkflowProposalService } from '../../graphs/services/workflow-proposal.service';
import type { WorkflowStoreService } from '../../graphs/services/workflow-store.service';
import type { MemoryService } from '../../memory/services/memory.service';
import type { ShareService } from '../../shares/services/share.service';
import type { WorkflowHistoryService } from '../../stats/services/workflow-history.service';
import type { McpTool } from '../mcp.types';
import { AnswerAgentTool } from './answer-agent/answer-agent.tool';
import { AskUserQuestionTool } from './ask-user-question/ask-user-question.tool';
import { AwaitAgentTool } from './await-agent/await-agent.tool';
import { BackupWorkflowTool } from './backup-workflow/backup-workflow.tool';
import { BoardTools } from './board/board.tools';
import { CallAgentTool } from './call-agent/call-agent.tool';
import { CancelAgentTool } from './cancel-agent/cancel-agent.tool';
import { ListAgentThreadsTool } from './list-agent-threads/list-agent-threads.tool';
import { ListMonitorsTool } from './list-monitors/list-monitors.tool';
import { MarkRecommendationsTool } from './mark-recommendations/mark-recommendations.tool';
import { MemoryForgetTool } from './memory-forget/memory-forget.tool';
import { MemoryReadTool } from './memory-read/memory-read.tool';
import { MemorySaveTool } from './memory-save/memory-save.tool';
import { MemorySearchTool } from './memory-search/memory-search.tool';
import { MessageAgentTool } from './message-agent/message-agent.tool';
import { MonitorTool } from './monitor/monitor.tool';
import { MoveStageTool } from './move-stage/move-stage.tool';
import { NotifyUserTool } from './notify-user/notify-user.tool';
import { ProposePatchTool } from './propose-patch/propose-patch.tool';
import { ProposePlanTool } from './propose-plan/propose-plan.tool';
import { ProposeWorkflowTool } from './propose-workflow/propose-workflow.tool';
import { PublishActionTool } from './publish-action/publish-action.tool';
import { ReadAnalyzedThreadTool } from './read-analyzed-thread/read-analyzed-thread.tool';
import { ReadChatContextTool } from './read-chat-context/read-chat-context.tool';
import { ReadWorkflowsTool } from './read-workflows/read-workflows.tool';
import { RecordOutcomeTool } from './record-outcome/record-outcome.tool';
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
import { TeamNoteTool } from './team-note/team-note.tool';
import { TeamNotesTool } from './team-notes/team-notes.tool';

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
  galleryImages: GalleryImageService;
  artifacts: ArtifactBroker;
  actions: ActionBroker;
  monitors: MonitorBroker;
  teamNotes: TeamNoteBroker;
  runOutcomes: RunOutcomeBroker;
  stages: StageService;
  patches: PatchBroker;
  plans: PlanBroker;
  notices: NotifyBroker;
  board: TaskBoardBroker;
  history: GlobalChatSearchService;
  memory: MemoryService;
  analysis: AnalysisBroker;
  threads: ThreadReaderService;
  workflowChanges: WorkflowChangeService;
  workflowHistory: WorkflowHistoryService;
  workflowGate: WorkflowProposalBroker;
  workflowBuilders: WorkflowBuilderBroker;
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
 * surface, the team notes, the run outcome, then the question, the render family, the action buttons, the
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
    new TeamNoteTool(deps.teamNotes),
    new TeamNotesTool(deps.teamNotes),
    new RecordOutcomeTool(deps.runOutcomes),
    new MoveStageTool(deps.stages, deps.calls),
    new AskUserQuestionTool(deps.questions),
    new ReportFindingsTool(deps.findings),
    new ShowChartTool(deps.charts),
    new ShowMetricsTool(deps.metrics),
    new ShowComparisonTool(deps.comparisons),
    new ShowGalleryTool(deps.galleries, deps.galleryImages),
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
    new MemorySearchTool(deps.memory),
    new MemoryReadTool(deps.memory),
    new MemorySaveTool(deps.memory),
    new MemoryForgetTool(deps.memory),
    new ReadWorkflowsTool(
      deps.workflowGate,
      deps.workflowBuilders,
      deps.workflowStore,
    ),
    new ProposeWorkflowTool(
      deps.workflowGate,
      deps.workflowBuilders,
      deps.workflowProposals,
    ),
    new ReadAnalyzedThreadTool(
      deps.analysis,
      deps.threads,
      deps.workflowChanges,
      deps.workflowHistory,
    ),
    new ReportRecommendationsTool(deps.analysis, deps.memory),
    new MarkRecommendationsTool(deps.analysis),
    new SaveWorkflowChangeTool(
      deps.analysis,
      deps.workflowBuilders,
      deps.threads,
      deps.workflowChanges,
    ),
    new BackupWorkflowTool(deps.workflowBuilders, deps.workflowChanges),
    new NotifyUserTool(deps.notices),
  ];
}

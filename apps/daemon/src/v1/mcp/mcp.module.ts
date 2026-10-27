import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { ActionBroker } from '../agents/services/action.broker';
import { AnalysisBroker } from '../agents/services/analysis.broker';
import { ArtifactBroker } from '../agents/services/artifact.broker';
import { ChartBroker } from '../agents/services/chart.broker';
import { ComparisonBroker } from '../agents/services/comparison.broker';
import { FindingsReportBroker } from '../agents/services/findings-report.broker';
import { GalleryBroker } from '../agents/services/gallery.broker';
import { GlobalChatSearchService } from '../agents/services/global-chat-search.service';
import { MetricsBroker } from '../agents/services/metrics.broker';
import { MonitorBroker } from '../agents/services/monitor.broker';
import { NotifyBroker } from '../agents/services/notify.broker';
import { PatchBroker } from '../agents/services/patch.broker';
import { PlanBroker } from '../agents/services/plan.broker';
import { RunOutcomeBroker } from '../agents/services/run-outcome.broker';
import { TeamNoteBroker } from '../agents/services/team-note.broker';
import { ThreadReaderService } from '../agents/services/thread-reader.service';
import { UserQuestionBroker } from '../agents/services/user-question.broker';
import { WorkflowBuilderBroker } from '../agents/services/workflow-builder.broker';
import { WorkflowProposalBroker } from '../agents/services/workflow-proposal.broker';
import { GraphsModule } from '../graphs/graphs.module';
import { CallBroker } from '../graphs/services/call-broker.service';
import { StageService } from '../graphs/services/stage.service';
import { TaskBoardBroker } from '../graphs/services/task-board.broker';
import { WorkflowChangeService } from '../graphs/services/workflow-change.service';
import { WorkflowProposalService } from '../graphs/services/workflow-proposal.service';
import { WorkflowStoreService } from '../graphs/services/workflow-store.service';
import { ShareService } from '../shares/services/share.service';
import { SharesModule } from '../shares/shares.module';
import { McpController } from './controllers/mcp.controller';
import { McpServerService } from './services/mcp-server.service';
import { createMcpTools, MCP_TOOLS } from './tools/mcp-tools';

/**
 * geniro's own MCP surface: the per-run endpoint (`/v1/mcp/<runId>/<nodeId>`)
 * and every tool it serves.
 *
 * Its own module because it sits ABOVE the two it serves: the render family's
 * brokers live in {@link AgentsModule}, the call runtime and the board's
 * rendezvous in {@link GraphsModule}, and the host needs both. Nothing imports
 * this module back.
 *
 * The tools are plain classes, one directory each under `tools/`, built by ONE
 * factory so their listing order is written in one place
 * ({@link createMcpTools}).
 */
@Module({
  imports: [AgentsModule, GraphsModule, SharesModule],
  controllers: [McpController],
  providers: [
    {
      provide: MCP_TOOLS,
      useFactory: (
        calls: CallBroker,
        questions: UserQuestionBroker,
        findings: FindingsReportBroker,
        charts: ChartBroker,
        metrics: MetricsBroker,
        comparisons: ComparisonBroker,
        galleries: GalleryBroker,
        artifacts: ArtifactBroker,
        actions: ActionBroker,
        monitors: MonitorBroker,
        teamNotes: TeamNoteBroker,
        runOutcomes: RunOutcomeBroker,
        stages: StageService,
        patches: PatchBroker,
        plans: PlanBroker,
        notices: NotifyBroker,
        board: TaskBoardBroker,
        history: GlobalChatSearchService,
        analysis: AnalysisBroker,
        threads: ThreadReaderService,
        workflowChanges: WorkflowChangeService,
        workflowGate: WorkflowProposalBroker,
        workflowBuilders: WorkflowBuilderBroker,
        workflowStore: WorkflowStoreService,
        workflowProposals: WorkflowProposalService,
        shares: ShareService,
      ) =>
        createMcpTools({
          calls,
          questions,
          findings,
          charts,
          metrics,
          comparisons,
          galleries,
          artifacts,
          actions,
          monitors,
          teamNotes,
          runOutcomes,
          stages,
          patches,
          plans,
          notices,
          board,
          history,
          analysis,
          threads,
          workflowChanges,
          workflowGate,
          workflowBuilders,
          workflowStore,
          workflowProposals,
          shares,
        }),
      inject: [
        CallBroker,
        UserQuestionBroker,
        FindingsReportBroker,
        ChartBroker,
        MetricsBroker,
        ComparisonBroker,
        GalleryBroker,
        ArtifactBroker,
        ActionBroker,
        MonitorBroker,
        TeamNoteBroker,
        RunOutcomeBroker,
        StageService,
        PatchBroker,
        PlanBroker,
        NotifyBroker,
        TaskBoardBroker,
        GlobalChatSearchService,
        AnalysisBroker,
        ThreadReaderService,
        WorkflowChangeService,
        WorkflowProposalBroker,
        WorkflowBuilderBroker,
        WorkflowStoreService,
        WorkflowProposalService,
        ShareService,
      ],
    },
    McpServerService,
  ],
})
export class McpModule {}

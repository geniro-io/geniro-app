import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { AnalysisBroker } from '../agents/services/analysis.broker';
import { ArtifactBroker } from '../agents/services/artifact.broker';
import { ChartBroker } from '../agents/services/chart.broker';
import { ComparisonBroker } from '../agents/services/comparison.broker';
import { FindingsReportBroker } from '../agents/services/findings-report.broker';
import { GalleryBroker } from '../agents/services/gallery.broker';
import { GlobalChatSearchService } from '../agents/services/global-chat-search.service';
import { MetricsBroker } from '../agents/services/metrics.broker';
import { NotifyBroker } from '../agents/services/notify.broker';
import { PatchBroker } from '../agents/services/patch.broker';
import { PlanBroker } from '../agents/services/plan.broker';
import { ThreadReaderService } from '../agents/services/thread-reader.service';
import { UserQuestionBroker } from '../agents/services/user-question.broker';
import { GraphsModule } from '../graphs/graphs.module';
import { CallBroker } from '../graphs/services/call-broker.service';
import { TaskBoardBroker } from '../graphs/services/task-board.broker';
import { WorkflowChangeService } from '../graphs/services/workflow-change.service';
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
  imports: [AgentsModule, GraphsModule],
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
        patches: PatchBroker,
        plans: PlanBroker,
        notices: NotifyBroker,
        board: TaskBoardBroker,
        history: GlobalChatSearchService,
        analysis: AnalysisBroker,
        threads: ThreadReaderService,
        workflowChanges: WorkflowChangeService,
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
          patches,
          plans,
          notices,
          board,
          history,
          analysis,
          threads,
          workflowChanges,
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
        PatchBroker,
        PlanBroker,
        NotifyBroker,
        TaskBoardBroker,
        GlobalChatSearchService,
        AnalysisBroker,
        ThreadReaderService,
        WorkflowChangeService,
      ],
    },
    McpServerService,
  ],
})
export class McpModule {}

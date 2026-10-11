import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { ArtifactBroker } from '../agents/services/artifact.broker';
import { ChartBroker } from '../agents/services/chart.broker';
import { ComparisonBroker } from '../agents/services/comparison.broker';
import { FindingsReportBroker } from '../agents/services/findings-report.broker';
import { GalleryBroker } from '../agents/services/gallery.broker';
import { MetricsBroker } from '../agents/services/metrics.broker';
import { NotifyBroker } from '../agents/services/notify.broker';
import { PatchBroker } from '../agents/services/patch.broker';
import { PlanBroker } from '../agents/services/plan.broker';
import { UserQuestionBroker } from '../agents/services/user-question.broker';
import { GraphsModule } from '../graphs/graphs.module';
import { CallBroker } from '../graphs/services/call-broker.service';
import { TaskBoardBroker } from '../graphs/services/task-board.broker';
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
      ],
    },
    McpServerService,
  ],
})
export class McpModule {}

import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { ActionBroker } from '../agents/services/action.broker';
import { AnalysisBroker } from '../agents/services/analysis.broker';
import { ArtifactBroker } from '../agents/services/artifact.broker';
import { ChartBroker } from '../agents/services/chart.broker';
import { ComparisonBroker } from '../agents/services/comparison.broker';
import { FindingsReportBroker } from '../agents/services/findings-report.broker';
import { GalleryBroker } from '../agents/services/gallery.broker';
import { GalleryImageService } from '../agents/services/gallery-image.service';
import { GlobalChatSearchService } from '../agents/services/global-chat-search.service';
import { MetricsBroker } from '../agents/services/metrics.broker';
import { MonitorBroker } from '../agents/services/monitor.broker';
import { NotifyBroker } from '../agents/services/notify.broker';
import { PatchBroker } from '../agents/services/patch.broker';
import { PlanBroker } from '../agents/services/plan.broker';
import { RunOutcomeBroker } from '../agents/services/run-outcome.broker';
import { TeamBuilderBroker } from '../agents/services/team-builder.broker';
import { TeamNoteBroker } from '../agents/services/team-note.broker';
import { TeamProposalBroker } from '../agents/services/team-proposal.broker';
import { ThreadReaderService } from '../agents/services/thread-reader.service';
import { UserQuestionBroker } from '../agents/services/user-question.broker';
import { MemoryModule } from '../memory/memory.module';
import { MemoryService } from '../memory/services/memory.service';
import { ShareService } from '../shares/services/share.service';
import { SharesModule } from '../shares/shares.module';
import { TeamHistoryService } from '../stats/services/team-history.service';
import { StatsModule } from '../stats/stats.module';
import { CallBroker } from '../teams/services/call-broker.service';
import { StageService } from '../teams/services/stage.service';
import { TaskBoardBroker } from '../teams/services/task-board.broker';
import { TeamChangeService } from '../teams/services/team-change.service';
import { TeamProposalService } from '../teams/services/team-proposal.service';
import { TeamStoreService } from '../teams/services/team-store.service';
import { TeamsModule } from '../teams/teams.module';
import { McpController } from './controllers/mcp.controller';
import { McpServerService } from './services/mcp-server.service';
import { createMcpTools, MCP_TOOLS } from './tools/mcp-tools';

/**
 * geniro's own MCP surface: the per-run endpoint (`/v1/mcp/<runId>/<nodeId>`)
 * and every tool it serves.
 *
 * Its own module because it sits ABOVE the two it serves: the render family's
 * brokers live in {@link AgentsModule}, the call runtime and the board's
 * rendezvous in {@link TeamsModule}, and the host needs both — and the
 * team history an analysis reads in {@link StatsModule}, which sits above
 * those two. Nothing imports this module back.
 *
 * The tools are plain classes, one directory each under `tools/`, built by ONE
 * factory so their listing order is written in one place
 * ({@link createMcpTools}).
 */
@Module({
  imports: [AgentsModule, TeamsModule, SharesModule, MemoryModule, StatsModule],
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
        galleryImages: GalleryImageService,
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
        memory: MemoryService,
        analysis: AnalysisBroker,
        threads: ThreadReaderService,
        teamChanges: TeamChangeService,
        teamHistory: TeamHistoryService,
        teamGate: TeamProposalBroker,
        teamBuilders: TeamBuilderBroker,
        teamStore: TeamStoreService,
        teamProposals: TeamProposalService,
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
          galleryImages,
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
          memory,
          analysis,
          threads,
          teamChanges,
          teamHistory,
          teamGate,
          teamBuilders,
          teamStore,
          teamProposals,
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
        GalleryImageService,
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
        MemoryService,
        AnalysisBroker,
        ThreadReaderService,
        TeamChangeService,
        TeamHistoryService,
        TeamProposalBroker,
        TeamBuilderBroker,
        TeamStoreService,
        TeamProposalService,
        ShareService,
      ],
    },
    McpServerService,
  ],
})
export class McpModule {}

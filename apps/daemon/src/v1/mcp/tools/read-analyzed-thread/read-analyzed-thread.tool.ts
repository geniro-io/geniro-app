import { Logger } from '@nestjs/common';

import { HOST_ANALYZED_THREAD_TOOL } from '../../../agents/chat.types';
import type { AnalysisBroker } from '../../../agents/services/analysis.broker';
import {
  maskedAnswer,
  pagedAnswer,
  type ThreadReaderService,
} from '../../../agents/services/thread-reader.service';
import { analysedRunIdsOf } from '../../../agents/utils/analysed-runs';
import type { TeamHistoryService } from '../../../stats/services/team-history.service';
import type { TeamChangeService } from '../../../teams/services/team-change.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { readAnalyzedThreadInstructions } from './read-analyzed-thread.instructions';
import {
  analyzedThreadResultText,
  historyAnswer,
  otherRunsAnswer,
  readAnalyzedThreadArgs,
  spendAnswer,
} from './read-analyzed-thread.reader';
import { readAnalyzedThreadSchema } from './read-analyzed-thread.schema';

const NOT_A_TEAM = {
  error: 'NOT_A_TEAM',
  message: 'The analysed thread is a plain chat (or is gone): it has no team.',
};

/**
 * `read_analyzed_thread` — an analysis chat's paged read of the one thread it
 * analyses, or of a team analysis's runs and any other run of that team it
 * names. Offered only while an analysis turn runs, and carries no
 * `readOnlyHint` (codex would skip its approval); its auto-approval is
 * `isHostAnalysisReadCall`'s, scoped by the broker's turn to those sources.
 */
export class ReadAnalyzedThreadTool extends BaseMcpTool {
  readonly name = HOST_ANALYZED_THREAD_TOOL;
  private readonly logger = new Logger(ReadAnalyzedThreadTool.name);

  constructor(
    private readonly analysis: AnalysisBroker,
    private readonly threads: ThreadReaderService,
    private readonly teams: TeamChangeService,
    private readonly history: TeamHistoryService,
  ) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.analysis.canAnalyse(runId, memberId);
  }

  protected instructions(): string {
    return readAnalyzedThreadInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return readAnalyzedThreadSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, memberId }: McpCallContext,
  ): Promise<McpToolResult> {
    const read = readAnalyzedThreadArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const turn = await this.analysis.turnOf(runId, memberId);
    if ('status' in turn) {
      return this.text(`Nothing to read: ${turn.reason}.`, true);
    }
    try {
      if (read.query.view === 'history' || read.query.view === 'spend') {
        const team = await this.threads.analysedTeamOf(turn);
        if (team === null) {
          return this.text(analyzedThreadResultText(NOT_A_TEAM));
        }
        const analysedRunIds = analysedRunIdsOf(turn);
        // Masked BEFORE any cut: a secret split across two pages matches in
        // neither, and the per-page pass would let both halves out.
        return this.text(
          analyzedThreadResultText(
            read.query.view === 'history'
              ? historyAnswer(
                  maskedAnswer({
                    ...(await this.history.read(team.slug, {
                      analysedRunIds,
                      readerRunId: runId,
                    })),
                  }),
                  read.query,
                )
              : spendAnswer(
                  maskedAnswer({
                    ...(await this.history.spend(team.slug, {
                      analysedRunIds,
                    })),
                  }),
                  read.query,
                ),
          ),
        );
      }
      if (
        read.query.view === 'runs' &&
        read.query.section !== undefined &&
        turn.team
      ) {
        return this.text(
          analyzedThreadResultText(
            otherRunsAnswer(
              maskedAnswer({
                team: turn.team.slug,
                otherRuns: await this.history.otherRuns(turn.team.slug, {
                  analysedRunIds: analysedRunIdsOf(turn),
                }),
              }),
              read.query,
            ),
          ),
        );
      }
      if (read.query.view !== 'team') {
        return this.text(
          analyzedThreadResultText(
            await this.threads.read(
              turn,
              read.query,
              (slug) => this.history.versionIndex(slug),
              (slug) => this.history.population(slug),
            ),
          ),
        );
      }
      const named = await this.threads.readSourceOf(turn, read.query.runId);
      if ('error' in named) {
        return this.text(analyzedThreadResultText(named));
      }
      const team = await this.threads.analysedTeamOf(turn, named);
      if (team === null) {
        return this.text(analyzedThreadResultText(NOT_A_TEAM));
      }
      return this.text(
        analyzedThreadResultText(
          pagedAnswer(
            // Masked BEFORE paging: a secret cut across two chunks matches
            // in neither, and the per-chunk pass would let both halves out.
            maskedAnswer(
              await this.teams.describe(
                team.slug,
                team.snapshot,
                team.instructions,
                team.baseSnapshot,
                {
                  snapshot: team.overlaySnapshot,
                  projectId: team.projectId ?? null,
                },
              ),
            ),
            read.query.offset ?? 0,
          ),
        ),
      );
    } catch (error) {
      // A failed read names database and file paths; the model is told a
      // fixed sentence, the rule `HostSinkBroker.deliver` states.
      this.logger.error(
        `run ${runId} could not read its analysed thread: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.text(
        `${this.name} failed internally — try a narrower read, or report what you have.`,
        true,
      );
    }
  }
}

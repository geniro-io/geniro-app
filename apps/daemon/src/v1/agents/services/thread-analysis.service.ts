import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConflictException, NotFoundException } from '@packages/common';
import type { Subscription } from 'rxjs';

import { type AgentKind, isTerminalRunStatus } from '../../runs/runs.types';
import type { RunWire } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import type { AgentOptionsSnapshot } from '../utils/agent-options';
import { resolveValidDirectory } from '../utils/resolve-directory';
import {
  analysedThreadKindOf,
  threadAnalysisBrief,
  threadAnalysisGuide,
} from '../utils/thread-analysis-guide';
import { AgentEventBus } from './agent-events.bus';
import { ChatService } from './chat.service';

/** What the "Analyze thread" dialog sends — see `AnalyzeThreadDto`. */
export interface StartThreadAnalysis {
  agentKind: AgentKind;
  model?: string;
  effort?: string;
  configDir?: string;
  cwd?: string;
  focus?: string;
  customInstructions?: string;
  replyLanguage?: string;
  agentOptions?: AgentOptionsSnapshot;
}

/** The folder canonicalized, or null when it is missing or not readable. */
function existingFolder(path: string): string | null {
  try {
    return resolveValidDirectory(path, {
      errorCode: 'ANALYSIS_FOLDER_GONE',
      noun: 'folder',
    });
  } catch {
    return null;
  }
}

/**
 * A thread's analysis: ONE chat per thread, linked to its source, carrying the
 * analysis method as its task instructions and sent the brief as its first
 * message — the board's own "create a chat, then message it" pattern
 * (`TaskRunsService.start`).
 *
 * It belongs to the thread it reads, the way the builder's chat belongs to its
 * workflow: the sidebar never lists it (`RunDao.listChats`), the source's
 * popup finds it ({@link find}), a new one replaces it, and it goes when the
 * source is deleted.
 */
@Injectable()
export class ThreadAnalysisService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ThreadAnalysisService.name);
  private deletedSubscription: Subscription | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly chats: ChatService,
    private readonly bus: AgentEventBus,
  ) {}

  /**
   * A deleted thread takes its analysis with it — nothing else could reach it.
   * Announced after the source's rows are gone, whichever route deleted it (a
   * chat, a workflow run, the archive's retention sweep).
   */
  onModuleInit(): void {
    this.deletedSubscription = this.bus.allDeleted().subscribe((runId) => {
      // Off the delete's own path, so nothing awaits it: a failed read of the
      // analyses is logged here rather than left an unhandled rejection.
      this.deleteAnalysesOf(runId).catch((err: unknown) => {
        this.logger.warn(
          `analyses of deleted ${runId} not looked up: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
  }

  /**
   * An analysis whose source is already gone — the delete above missed it:
   * the daemon stopped before the announce was handled, or the delete failed —
   * is reachable from nowhere and still holds the deleted thread's words.
   * Swept once per boot, off the ready path.
   */
  onApplicationBootstrap(): void {
    void this.sweepOrphans().catch((err: unknown) => {
      this.logger.warn(
        `orphaned analyses not swept: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  onModuleDestroy(): void {
    this.deletedSubscription?.unsubscribe();
  }

  /** Delete every analysis whose source thread no longer exists. */
  async sweepOrphans(): Promise<void> {
    const orphans = await this.runDao.listOrphanedAnalyses(this.em.fork());
    await this.deleteRuns(
      'a deleted thread',
      orphans.map((run) => run.id),
    );
  }

  /** The thread's analysis as it reads now, or null when it has none. */
  async find(sourceRunId: string): Promise<RunWire | null> {
    const source = await this.runDao.getById(sourceRunId, this.em.fork());
    if (source === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${sourceRunId}`);
    }
    return this.chats.findAnalysis(sourceRunId);
  }

  async start(
    sourceRunId: string,
    input: StartThreadAnalysis,
  ): Promise<RunWire> {
    const em = this.em.fork();
    const source = await this.runDao.getById(sourceRunId, em);
    if (source === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${sourceRunId}`);
    }
    if (source.archivedAt !== null) {
      throw new ConflictException(
        'ANALYSIS_SOURCE_ARCHIVED',
        'an archived thread cannot be analysed — restore it first',
      );
    }
    if (source.analysisSourceRunId !== null) {
      throw new ConflictException(
        'ANALYSIS_OF_ANALYSIS',
        'this thread is itself an analysis — analyse the thread it reads instead',
      );
    }
    // The source's own folder, unless it is gone: repo recommendations are
    // edits in the tree the analysed thread worked in, so a different folder
    // is the user's call, made in the dialog.
    // A folder the user picked is checked with the reason said; only the
    // source's own folder going missing asks for one.
    const cwd =
      input.cwd !== undefined
        ? resolveValidDirectory(input.cwd, {
            errorCode: 'ANALYSIS_FOLDER_GONE',
            noun: 'folder',
          })
        : source.cwd === null
          ? null
          : existingFolder(source.cwd);
    if (cwd === null) {
      throw new ConflictException(
        'ANALYSIS_FOLDER_GONE',
        "the thread's folder no longer exists — pick a folder to run the analysis in",
      );
    }
    const { snapshotSeq, working } = await this.snapshotOf(sourceRunId, em);
    if (snapshotSeq < 0) {
      throw new ConflictException(
        'ANALYSIS_SOURCE_EMPTY',
        'the thread has nothing in it to analyse yet',
      );
    }
    // The analyses this start replaces, read BEFORE it creates its own: a
    // start racing it (a second window, the phone) creates one too, and
    // deleting "every analysis but mine" afterwards would delete each
    // other's. The newest then wins `findAnalysis`, and both survive.
    const earlier = (await this.runDao.listAnalysesOf(source.id, em)).map(
      (analysis) => analysis.id,
    );
    const kind = analysedThreadKindOf(source);
    const run = await this.chats.createChat({
      agentKind: input.agentKind,
      cwd,
      model: input.model,
      effort: input.effort,
      configDir: input.configDir,
      customInstructions: input.customInstructions,
      replyLanguage: input.replyLanguage,
      agentOptions: input.agentOptions,
      title: `Analysis: ${source.title ?? 'untitled thread'}`,
      taskInstructions: threadAnalysisGuide(kind, input.focus ?? null),
      analysisSource: {
        runId: source.id,
        seq: snapshotSeq,
        working,
      },
    });
    try {
      await this.chats.sendMessage(
        run.id,
        threadAnalysisBrief({ title: source.title, kind }),
      );
    } catch (error) {
      // An analysis chat that never got its brief is an empty thread with a
      // method and nothing to apply it to; the dialog stays open on the
      // refusal, so the user retries rather than finding it later.
      await this.chats.delete(run.id).catch(() => undefined);
      throw error;
    }
    // Only now is the earlier analysis replaced: a start that fails above
    // leaves the thread the one it had.
    await this.deleteRuns(source.id, earlier);
    // Its own row as it reads after the brief, not the copy taken before it —
    // the popup opens on this, and a `pending` copy would show no Stop.
    return (await this.chats.findAnalysis(source.id, run.id)) ?? run;
  }

  /** Delete every analysis of a thread. */
  private async deleteAnalysesOf(sourceRunId: string): Promise<void> {
    const analyses = await this.runDao.listAnalysesOf(
      sourceRunId,
      this.em.fork(),
    );
    await this.deleteRuns(
      sourceRunId,
      analyses.map((analysis) => analysis.id),
    );
  }

  /**
   * Delete these analyses. One failing is logged and the rest still go: an
   * analysis nothing lists is reachable from nowhere else.
   */
  private async deleteRuns(
    sourceLabel: string,
    analysisIds: readonly string[],
  ): Promise<void> {
    for (const id of analysisIds) {
      await this.chats.delete(id).catch((err: unknown) => {
        this.logger.warn(
          `analysis ${id} of ${sourceLabel} not deleted: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  /**
   * The source's newest seq and whether it was working at it, read so the two
   * belong together: a turn starting or settling between two separate reads
   * would pair a snapshot with the wrong flag, and the flag is kept for good.
   * Re-read until no row landed in between.
   */
  private async snapshotOf(
    sourceRunId: string,
    em: EntityManager,
  ): Promise<{ snapshotSeq: number; working: boolean }> {
    let before = await this.itemDao.maxSeq(sourceRunId, em);
    for (let attempt = 0; ; attempt += 1) {
      // A fresh fork each pass: the one above already holds the run, and its
      // identity map would answer with the status read before the loop.
      const run = await this.runDao.getById(sourceRunId, this.em.fork());
      const after = await this.itemDao.maxSeq(sourceRunId, em);
      if (after === before || attempt >= 4) {
        return {
          snapshotSeq: after,
          working: run !== null && !isTerminalRunStatus(run.status),
        };
      }
      before = after;
    }
  }
}

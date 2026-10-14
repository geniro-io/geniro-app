import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { ConflictException, NotFoundException } from '@packages/common';

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
 * Starts an analysis of one thread: a NEW chat, linked to its source, carrying
 * the analysis method as its task instructions and sent the brief as its first
 * message — the board's own "create a chat, then message it" pattern
 * (`TaskRunsService.start`).
 */
@Injectable()
export class ThreadAnalysisService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly chats: ChatService,
  ) {}

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
    const kind = analysedThreadKindOf(source);
    const run = await this.chats.createChat({
      agentKind: input.agentKind,
      cwd,
      model: input.model,
      effort: input.effort,
      configDir: input.configDir,
      customInstructions: input.customInstructions,
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
    return run;
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

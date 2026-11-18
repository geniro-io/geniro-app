import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import { environment } from '../../../environments';
import { ProjectDao } from '../../projects/dao/project.dao';
import { ProjectRootsService } from '../../projects/services/project-roots.service';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { mapEventToItem } from '../utils/event-to-item';
import { persistItemAndEmit } from '../utils/persist-item';
import { resolveValidCwd } from '../utils/resolve-cwd';
import { existingDirectory } from '../utils/resolve-directory';
import {
  isFolderGone,
  movedFolderNote,
  movedFolderOf,
} from '../utils/turn-folder';
import { AgentEventBus } from './agent-events.bus';
import { AgentSessionRegistry } from './agent-session.registry';
import { ItemCallIndexService } from './item-call-index.service';
import { ItemSeqAllocator } from './item-seq.allocator';

/**
 * The folder every turn of a run starts in, chat and team alike.
 *
 * A run's folder is routinely deleted under it — a worktree a pipeline or the
 * board removed once the work was done — while the run can still be woken. A
 * turn never starts in a missing folder: the run is moved, once, to the folder
 * its worktree was cut from ({@link movedFolderOf}), with one info row in its
 * transcript and one prompt line for each of its conversations' next turns
 * ({@link oweMoveNote}); with no such folder the turn is refused
 * `FOLDER_GONE`. The deleted folder is never re-created. A card's Run press
 * puts the run back into the worktree it cut ({@link returnTo}), told the
 * same way.
 */
@Injectable()
export class TurnFolderService {
  private readonly logger = new Logger(TurnFolderService.name);
  private readonly moving = new Map<string, Promise<string>>();
  private readonly listeners = new Set<(runId: string) => void>();
  /** Per run, the newest move's prompt line and the conversations told it. */
  private readonly moveNotes = new Map<
    string,
    { prompt: string; told: Set<string> }
  >();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly projectDao: ProjectDao,
    private readonly projectRoots: ProjectRootsService,
    private readonly itemDao: ItemDao,
    private readonly bus: AgentEventBus,
    private readonly calls: ItemCallIndexService,
    private readonly seqs: ItemSeqAllocator,
    private readonly sessions: AgentSessionRegistry,
  ) {}

  /** Be told each run this service moved to another folder. */
  onMoved(listener: (runId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Owe the conversation `sessionKey` of `runId` the run's newest move, once:
   * every conversation of a run shares its folder, so each is told before
   * its first turn there. Called right before a turn starts.
   */
  oweMoveNote(runId: string, sessionKey: string): void {
    const note = this.moveNotes.get(runId);
    if (note === undefined || note.told.has(sessionKey)) {
      return;
    }
    if (this.sessions.oweKeyNote(sessionKey, note.prompt)) {
      note.told.add(sessionKey);
    }
  }

  /**
   * Put a run its folder's deletion moved back into `worktree` — the one a
   * card's Run press just cut — with the chip's start commit that press
   * measured. A run already there is left alone; a move racing it is read
   * again and undone once more.
   */
  async returnTo(
    runId: string,
    worktree: string,
    start: { startSha: string | null; startDirty: boolean | null },
  ): Promise<void> {
    const target = existingDirectory(worktree);
    if (target === null) {
      return;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const em = this.em.fork();
      const run = await this.runDao.getById(runId, em);
      if (run === null || run.cwd === null || run.cwd === target) {
        return;
      }
      if (await this.runDao.rehome(runId, run.cwd, target, start, em)) {
        await this.announceMove(
          runId,
          {
            transcript: `This thread works in its card's worktree ${target} again.`,
            prompt: `You work in ${JSON.stringify(target)} again, the card's worktree; the folder ${JSON.stringify(run.cwd)} is no longer yours to change.`,
          },
          em,
        );
        return;
      }
    }
  }

  /**
   * The canonical folder a turn of `runId` starts in: `cwd` while it exists,
   * else the one the run is moved to. Concurrent turns of one run share one
   * move. Throws `INVALID_CWD` for a folder that exists but cannot be used,
   * `FOLDER_GONE` for a gone one with no folder to move to.
   */
  async folderFor(runId: string, cwd: string | null): Promise<string> {
    if (cwd === null || !isFolderGone(cwd)) {
      return resolveValidCwd(cwd ?? '');
    }
    const key = `${runId}\u0000${cwd}`;
    const pending = this.moving.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const move = this.move(runId, cwd).finally(() => {
      this.moving.delete(key);
    });
    this.moving.set(key, move);
    return move;
  }

  private async move(runId: string, gone: string): Promise<string> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (run === null) {
      return resolveValidCwd(gone);
    }
    if (run.cwd !== null && run.cwd !== gone) {
      const current = existingDirectory(run.cwd);
      if (current !== null) {
        return current;
      }
    }
    const project =
      run.projectId === null
        ? null
        : await this.projectDao.getById(run.projectId, em);
    const folder = await movedFolderOf(gone, {
      source: (await this.projectRoots.rootsOf([gone])).get(gone) ?? null,
      project: project?.folder ?? null,
      userDataDir: environment.userDataDir,
    });
    if (folder === null) {
      throw new BadRequestException(
        'FOLDER_GONE',
        `The folder ${gone} was deleted, and it came from no card, repository or project folder this thread could carry on in.`,
      );
    }
    const back = existingDirectory(gone);
    if (back !== null) {
      return back;
    }
    const from = run.cwd ?? gone;
    const forgotten = { startSha: null, startDirty: null };
    if (!(await this.runDao.rehome(runId, from, folder, forgotten, em))) {
      const now = await this.runDao.getById(runId, this.em.fork());
      const current = now?.cwd == null ? null : existingDirectory(now.cwd);
      return current ?? resolveValidCwd(gone);
    }
    await this.announceMove(runId, movedFolderNote(gone, folder), em);
    return folder;
  }

  private async announceMove(
    runId: string,
    note: { transcript: string; prompt: string },
    em: EntityManager,
  ): Promise<void> {
    this.moveNotes.set(runId, { prompt: note.prompt, told: new Set() });
    await this.writeNotice(runId, note.transcript, em);
    for (const listener of this.listeners) {
      listener(runId);
    }
  }

  private async writeNotice(
    runId: string,
    message: string,
    em: EntityManager,
  ): Promise<void> {
    const row = mapEventToItem({
      type: 'notice',
      message,
      severity: 'info',
      caption: 'folder moved',
    })!;
    try {
      await persistItemAndEmit(
        {
          itemDao: this.itemDao,
          bus: this.bus,
          calls: this.calls,
          seqs: this.seqs,
        },
        em,
        {
          runId,
          memberId: null,
          seq: await this.seqs.reserve(runId),
          kind: row.kind,
          role: row.role,
          payload: row.payload,
        },
      );
    } catch (err) {
      this.logger.warn(
        `run ${runId}: could not record its move to another folder: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

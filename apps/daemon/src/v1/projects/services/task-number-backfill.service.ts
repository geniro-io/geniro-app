import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, Optional } from '@nestjs/common';

import { environment } from '../../../environments';
import { TaskDao } from '../../tasks/dao/task.dao';
import { ProjectDao } from '../dao/project.dao';
import { projectKey } from '../utils/project-key';

/**
 * The marker that retires this migration, in the userData dir beside the
 * database it repaired — the shape `workflow-titles-backfilled` records in
 * full.
 */
const MARKER_FILE = 'task-numbers-backfilled';

/**
 * One-time sweep: give every board a key and every card a number.
 *
 * Cards gained an identifier (`GEN-12`) after boards already had cards on them,
 * and the two halves of it are written at CREATION — a project's key from its
 * name, a card's number from the project's counter. Nothing revisits a row that
 * already exists, so without this every card made before the change would draw
 * no identifier for the rest of its life, on the one board a user has actually
 * been working.
 *
 * It runs at boot beside the other launch sweeps, because there is no other
 * moment: a card is not re-saved when it is looked at.
 *
 * **ONCE, ever** — {@link MARKER_FILE} retires it. Unlike a repair that could
 * recur, the condition here closes itself: both fields are written on every
 * create from now on. Running it every launch would make it a permanent rule
 * rather than a migration, and this one WRITES — a re-run against a board whose
 * key a user later edits would silently put the derived one back.
 *
 * Numbers are handed out in CREATION order, oldest card first, so the
 * identifiers read the way they would have if numbering had always existed. The
 * project's counter is left standing at the highest number handed out, which is
 * what keeps the next card made after the sweep from colliding with one of
 * these.
 *
 * It is bounded per project rather than globally: numbering is per board, and a
 * failure on one board must not leave another half-numbered — so each project
 * is flushed on its own.
 */
@Injectable()
export class TaskNumberBackfillService {
  private readonly logger = new Logger(TaskNumberBackfillService.name);

  private readonly markerPath: string;

  constructor(
    private readonly projectDao: ProjectDao,
    private readonly taskDao: TaskDao,
    private readonly em: EntityManager,
    /** Test seam only — nothing in the app passes it. */
    @Optional() markerPath?: string,
  ) {
    this.markerPath = markerPath ?? join(environment.userDataDir, MARKER_FILE);
  }

  /**
   * Returns how many cards were numbered, or null when the migration had
   * already run and this launch did nothing.
   */
  async backfill(): Promise<number | null> {
    if (await this.alreadyRun()) {
      return null;
    }
    const em = this.em.fork();
    let numbered = 0;
    for (const project of await this.projectDao.listAll(em)) {
      project.taskKey ??= projectKey(project.name);
      const tasks = (await this.taskDao.listForProject(project.id, em))
        .filter((task) => task.number === null)
        // Oldest first, so the identifiers read the way they would have if
        // numbering had always existed. `createdAt` is a timestamp rather than
        // a sequence, so ties are broken by id to keep this deterministic —
        // two cards made in the same millisecond must not swap numbers between
        // one run of the sweep and a repeat of it after a crash.
        .sort(
          (a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime() ||
            a.id.localeCompare(b.id),
        );
      for (const task of tasks) {
        project.taskCounter += 1;
        task.number = project.taskCounter;
        numbered += 1;
      }
      await em.flush();
    }
    await this.markDone();
    return numbered;
  }

  /** Whether a previous launch already ran this migration to completion. */
  private async alreadyRun(): Promise<boolean> {
    try {
      await access(this.markerPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retire the migration.
   *
   * A failed write is swallowed on the rule the whole sweep follows: the repair
   * has already landed, and the cost of not recording it is one more scan next
   * launch — where refusing the boot over a marker file would cost the user
   * their app. A re-run is harmless in exactly this case, since every card it
   * would look at now has a number.
   */
  private async markDone(): Promise<void> {
    try {
      await writeFile(this.markerPath, `${new Date().toISOString()}\n`, 'utf8');
    } catch (err) {
      this.logger.warn(
        `could not record the task-number backfill as done: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The boot entry point: never throws, and never delays the launch on its own
   * account — a sweep of the board is not a reason for the daemon to refuse to
   * start.
   */
  async backfillQuietly(): Promise<void> {
    try {
      const numbered = await this.backfill();
      if (numbered !== null && numbered > 0) {
        this.logger.log(
          `numbered ${numbered} task(s) that predate identifiers`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `task number backfill failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

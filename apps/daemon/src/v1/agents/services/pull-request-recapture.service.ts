import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, Optional } from '@nestjs/common';

import { environment } from '../../../environments';
import { RunDao } from '../dao/run.dao';
import { PullRequestCaptureService } from './pull-request-capture.service';

/**
 * The marker that retires this migration, in the userData dir beside the
 * database it repaired — a FILE, on `WorkflowTitleBackfillService`'s
 * reasoning: the daemon never opens `settings.json`, and a row would put a
 * one-release migration's bookkeeping in the schema for good.
 */
const MARKER_FILE = 'pull-requests-recaptured';

/**
 * One-time sweep: forget every run's captured pull requests and capture them
 * again under the rule that holds NOW.
 *
 * The rule was tightened (`utils/pull-request-capture.ts`): a tool call
 * merely CONTAINING `gh pr create` used to count as having run it, and a URL
 * anywhere in its result as the one it printed — so a sub-agent grepping an
 * exported transcript for that command filed the transcript's own pull
 * request under the thread doing the reading. Measured on this app's own
 * conversation, drawn in its header as opened by it.
 *
 * Tightening the rule does not touch what it had already filed: the capture
 * is incremental (`Run.pullRequestsScannedSeq`), so a stale entry stays on the
 * row for the life of the run. So the sweep has two halves.
 *
 * **The RESET runs before the server listens** ({@link recapture}): the list
 * and the marker are forgotten together, which is what makes the next pass
 * read the transcript from its first row. It is ahead of the listen so no
 * listing can merge a stale list back in — a pass over a reset row starts from
 * nothing, whoever runs it.
 *
 * **The RE-CAPTURE runs after it, in the background**
 * ({@link recaptureResetRunsQuietly}). Waiting for the next chat listing was
 * not enough: a listing captures only the runs in its scope, so an ARCHIVED
 * run stayed empty until someone opened the archive, and `TaskMergeService`
 * reads the column directly — a card in review whose chat was archived would
 * never have moved to done on merge. Not awaited, because re-reading several
 * dozen transcripts measured ~9s, which is not a reason to delay the app.
 *
 * Only runs HOLDING a captured list are reset. A run with none can carry no
 * misattributed one, and resetting every run would re-read every transcript in
 * the database.
 *
 * **ONCE, ever** — {@link MARKER_FILE} retires it, written once the reset has
 * landed. Run every launch, it would discard the capture's marker each time.
 * If the background re-capture dies, the reset rows are simply read by the
 * next listing that shows them.
 */
@Injectable()
export class PullRequestRecaptureService {
  private readonly logger = new Logger(PullRequestRecaptureService.name);

  private readonly markerPath: string;

  /** The runs {@link recapture} reset this launch, awaiting their re-capture. */
  private resetRunIds: string[] = [];

  constructor(
    private readonly runDao: RunDao,
    private readonly capture: PullRequestCaptureService,
    private readonly em: EntityManager,
    /** Test seam only — nothing in the app passes it. */
    @Optional() markerPath?: string,
  ) {
    this.markerPath = markerPath ?? join(environment.userDataDir, MARKER_FILE);
  }

  /**
   * Returns how many runs were reset, or null when the migration had already
   * run and this launch did nothing.
   */
  async recapture(): Promise<number | null> {
    if (await this.alreadyRun()) {
      return null;
    }
    const em = this.em.fork();
    const runs = await this.runDao.listWithPullRequests(em);
    for (const run of runs) {
      await this.runDao.forgetPullRequestCapture(run.id, em);
    }
    this.resetRunIds = runs.map((run) => run.id);
    // Retired whether or not anything was reset: a fresh install has nothing
    // to repair and must not re-scan for the life of the app.
    await this.markDone();
    return runs.length;
  }

  /**
   * Capture the runs {@link recapture} reset, now, rather than waiting for a
   * listing that may never show them. Returns how many were captured.
   */
  async recaptureResetRuns(): Promise<number> {
    const ids = this.resetRunIds;
    this.resetRunIds = [];
    if (ids.length === 0) {
      return 0;
    }
    const em = this.em.fork();
    const runs = await this.runDao.getAll({ id: { $in: ids } }, undefined, em);
    // `sync` reads each run from its marker — null after the reset, so from
    // the first row — and swallows a failure per run.
    await this.capture.sync(runs, em);
    return runs.length;
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
   * A failed write is swallowed on the sweep's own rule: the resets have
   * landed, and the cost of not recording it is one more sweep next launch —
   * a re-read of a handful of transcripts — where refusing the boot over a
   * marker file would cost the user their app.
   */
  private async markDone(): Promise<void> {
    try {
      await writeFile(this.markerPath, `${new Date().toISOString()}\n`, 'utf8');
    } catch (err) {
      this.logger.warn(
        `could not record the pull-request recapture as done: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The boot entry point: never throws, and never delays the launch on its own
   * account — a sweep of run history is not a reason for the daemon to refuse
   * to start.
   */
  async recaptureQuietly(): Promise<void> {
    try {
      const reset = await this.recapture();
      if (reset !== null && reset > 0) {
        this.logger.log(
          `forgot the captured pull requests of ${reset} run(s); capturing them again once the daemon is listening`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `pull-request recapture failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** The post-listen entry point: never throws, and is not awaited. */
  async recaptureResetRunsQuietly(): Promise<void> {
    try {
      const captured = await this.recaptureResetRuns();
      if (captured > 0) {
        this.logger.log(
          `captured the pull requests of ${captured} run(s) again`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `re-capturing pull requests failed — the next listing reads them instead: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

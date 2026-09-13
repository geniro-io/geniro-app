import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, Optional } from '@nestjs/common';

import { environment } from '../../../environments';
import { RunDao } from '../dao/run.dao';

/**
 * The marker that retires this migration, in the userData dir beside the
 * database it repaired — a FILE, on `WorkflowTitleBackfillService`'s
 * reasoning: the daemon never opens `settings.json`, and a row would put a
 * one-release migration's bookkeeping in the schema for good.
 */
const MARKER_FILE = 'pull-requests-recaptured';

/**
 * One-time sweep: forget every run's captured pull requests, so the next chat
 * listing reads them again under the capture rule that holds NOW.
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
 * row for the life of the run. Forgetting the list and the marker together is
 * what makes the next listing re-read the transcript from its first row — the
 * capture already does that for a run whose marker is null.
 *
 * Only runs HOLDING a captured list are reset. A run with none can carry no
 * misattributed one, and the rule only ever got stricter, so nothing a reset
 * could find is missing from those rows — while resetting every run would
 * have the next listing re-read every transcript in the database (measured at
 * 3.8s for ONE list whose largest run holds 14,068 items).
 *
 * **ONCE, ever** — {@link MARKER_FILE} retires it. Run every launch, it would
 * discard the capture's marker each time and re-read every listed run's whole
 * transcript on every first listing, which is the cost the marker exists to
 * avoid. The corruption it repairs cannot recur under the new rule.
 */
@Injectable()
export class PullRequestRecaptureService {
  private readonly logger = new Logger(PullRequestRecaptureService.name);

  private readonly markerPath: string;

  constructor(
    private readonly runDao: RunDao,
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
    // Retired whether or not anything was reset: a fresh install has nothing
    // to repair and must not re-scan for the life of the app.
    await this.markDone();
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
          `forgot the captured pull requests of ${reset} run(s); the next chat listing reads them again`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `pull-request recapture failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

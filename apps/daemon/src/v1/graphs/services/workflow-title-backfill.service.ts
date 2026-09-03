import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, Optional } from '@nestjs/common';

import { environment } from '../../../environments';
import { RunDao } from '../../agents/dao/run.dao';
import { WorkflowStoreService } from './workflow-store.service';

/**
 * The marker that retires this migration, in the userData dir beside the
 * database it repaired.
 *
 * A FILE rather than a settings key or a row: the daemon never opens
 * `settings.json`, and a row would put a one-release migration's bookkeeping in
 * the schema for good.
 */
const MARKER_FILE = 'workflow-titles-backfilled';

/**
 * One-time sweep: forget a workflow run's title where that title is only the
 * WORKFLOW's own name.
 *
 * The executor used to stamp `title: workflow.name` on every run it created,
 * and it now leaves the title null so `ChatTitleService` can derive one from
 * the seed prompt. That guard reads `title !== null` as "already named" — which
 * is right for a rename and wrong for the stamp — so every run created before
 * the change kept the workflow's name as its title, while the row ALSO draws
 * that name as its label chip. The result is a sidebar row saying which
 * workflow twice and which task not once, which is the report the derivation
 * was built for, left standing on the history.
 *
 * It runs at boot, beside the other launch sweeps, because there is no other
 * moment: nothing re-visits a settled run, and the derivation only fires on a
 * turn that ends.
 *
 * **ONCE, ever** — {@link MARKER_FILE} retires it, and that is what makes the
 * guarantee below true rather than merely intended. The condition it repairs
 * can only arise once, since the executor now writes `title: null`; run every
 * launch instead, it stops being a migration and becomes a permanent rule, and
 * a user who renames a run to exactly its workflow's name — the likeliest thing
 * to type — would find that title erased at the next start, and the one after.
 * The sibling `UsageBackfillService` argues its own boundedness the same way
 * and reaches the opposite answer for the opposite reason: its sweep repairs a
 * gap that recurs, so it re-reads a bounded window every launch.
 *
 * It lives in THIS module rather than beside `ChatTitleService`, and that is
 * forced rather than chosen: the predicate needs the workflow's NAME, which
 * lives in the YAML library `WorkflowStoreService` owns, and `GraphsModule`
 * imports `AgentsModule` — never the reverse.
 *
 * **It clears a user-visible field with no undo**, so the predicate is exact:
 * the title must equal, byte for byte, the current name of the run's OWN
 * workflow. Anything derived and anything belonging to a workflow since
 * renamed is left alone — a run whose workflow was renamed keeps a title that
 * at least once meant something, which is a better answer than erasing it on a
 * guess. A user's own rename is out of reach for the reason above rather than
 * because of the predicate, which cannot tell one from the stamp: after this
 * has run once it never looks again.
 */
@Injectable()
export class WorkflowTitleBackfillService {
  private readonly logger = new Logger(WorkflowTitleBackfillService.name);

  private readonly markerPath: string;

  constructor(
    private readonly runDao: RunDao,
    private readonly workflows: WorkflowStoreService,
    private readonly em: EntityManager,
    /** Test seam only — nothing in the app passes it. */
    @Optional() markerPath?: string,
  ) {
    this.markerPath = markerPath ?? join(environment.userDataDir, MARKER_FILE);
  }

  /**
   * Returns how many titles were cleared, or null when the migration had
   * already run and this launch did nothing.
   */
  async backfill(): Promise<number | null> {
    if (await this.alreadyRun()) {
      return null;
    }
    const em = this.em.fork();
    // Titled workflow runs only, filtered and projected in SQL: this is the
    // pre-listen boot path, and a run with no title can never match the
    // predicate below. Archived rows are included — they are still listed under
    // Show all and still draw the doubled row.
    const runs = await this.runDao.listTitledWorkflowRuns(em);
    if (runs.length === 0) {
      // The migration RAN and had nothing to do, which retires it just as
      // firmly as clearing a row would — a fresh install must not re-scan for
      // the life of the app.
      await this.markDone();
      return 0;
    }
    const nameBySlug = new Map<string, string>();
    for (const summary of await this.workflows.list()) {
      nameBySlug.set(summary.slug, summary.name);
    }
    let cleared = 0;
    for (const run of runs) {
      const title = run.title;
      if (title === null || run.workflowId === null) {
        continue;
      }
      if (nameBySlug.get(run.workflowId) !== title) {
        continue;
      }
      if (await this.runDao.forgetTitle(run.id, title, em)) {
        cleared += 1;
      }
    }
    await this.markDone();
    return cleared;
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
   * A failed write is swallowed on the same rule the whole sweep follows: the
   * repair itself has already landed, and the cost of not recording it is one
   * more scan next launch — where refusing the boot over a marker file would
   * cost the user their app.
   */
  private async markDone(): Promise<void> {
    try {
      await writeFile(this.markerPath, `${new Date().toISOString()}\n`, 'utf8');
    } catch (err) {
      this.logger.warn(
        `could not record the workflow-title backfill as done: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The boot entry point: never throws, and never delays the launch on its own
   * account.
   *
   * A sweep of run history is not a reason for the daemon to refuse to start —
   * the same rule `UsageBackfillService` states — so a failure is logged and
   * the app comes up with the doubled rows it already had.
   */
  async backfillQuietly(): Promise<void> {
    try {
      const cleared = await this.backfill();
      if (cleared !== null && cleared > 0) {
        this.logger.log(
          `cleared ${cleared} workflow run title(s) that only repeated the workflow's name`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `workflow title backfill failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

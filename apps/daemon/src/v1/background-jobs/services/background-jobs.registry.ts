import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { BadRequestException } from '@packages/common';
import { type Observable, Subject, type Subscription } from 'rxjs';

import type {
  BackgroundJob,
  BackgroundJobList,
  BackgroundJobListQuery,
  BackgroundJobsChangedEvent,
  BackgroundJobSource,
} from '../background-jobs.types';

/** Extra jobs asked of each source, so jobs sharing the cursor's moment are not lost at a page edge. */
const TIE_SLACK = 20;
const CURSOR_SEPARATOR = '~';

/**
 * The one list of geniro's background work. Each kind registers its own
 * source (lessons do, from `LessonsModule`), so this module imports none of
 * them; the list merges their jobs and every source's change becomes one
 * `background_jobs_changed` broadcast.
 */
@Injectable()
export class BackgroundJobsRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(BackgroundJobsRegistry.name);
  private readonly sources = new Map<string, BackgroundJobSource>();
  private readonly subscriptions: Subscription[] = [];
  private readonly changed = new Subject<BackgroundJobsChangedEvent>();

  register(source: BackgroundJobSource): void {
    if (this.sources.has(source.kind)) {
      throw new Error(`background job source ${source.kind} registered twice`);
    }
    this.sources.set(source.kind, source);
    this.subscriptions.push(
      source.changes().subscribe({
        next: () => this.changed.next({ kind: source.kind }),
        error: (err: unknown) =>
          this.logger.error(
            `${source.kind} background jobs errored: ${String(err)}`,
          ),
      }),
    );
  }

  allChanges(): Observable<BackgroundJobsChangedEvent> {
    return this.changed.asObservable();
  }

  async list(query: BackgroundJobListQuery): Promise<BackgroundJobList> {
    const before = parseCursor(query.before);
    const sources = [...this.sources.values()];
    const active = (
      await Promise.all(sources.map((source) => source.active()))
    ).flat();
    active.sort(
      (a, b) =>
        Number(b.status === 'running') - Number(a.status === 'running') ||
        newestFirst(a, b),
    );
    const finished = (
      await Promise.all(
        sources.map((source) =>
          source.finished({
            notAfter: before === null ? null : new Date(before.startedAt),
            limit: query.limit + TIE_SLACK,
          }),
        ),
      )
    )
      .flat()
      .filter((job) => before === null || newestFirst(job, before) > 0)
      .sort(newestFirst);
    const page = finished.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      active,
      finished: page,
      nextBefore:
        finished.length > query.limit && last !== undefined
          ? `${last.startedAt}${CURSOR_SEPARATOR}${last.id}`
          : null,
      running: active.length,
    };
  }

  onModuleDestroy(): void {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
    this.changed.complete();
  }
}

function newestFirst(
  a: Pick<BackgroundJob, 'startedAt' | 'id'>,
  b: Pick<BackgroundJob, 'startedAt' | 'id'>,
): number {
  const byTime = Date.parse(b.startedAt) - Date.parse(a.startedAt);
  if (byTime !== 0) {
    return byTime;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function parseCursor(
  cursor: string | undefined,
): Pick<BackgroundJob, 'startedAt' | 'id'> | null {
  if (cursor === undefined || cursor === '') {
    return null;
  }
  const at = cursor.indexOf(CURSOR_SEPARATOR);
  const startedAt = at < 0 ? '' : cursor.slice(0, at);
  const id = at < 0 ? '' : cursor.slice(at + 1);
  if (id === '' || Number.isNaN(Date.parse(startedAt))) {
    throw new BadRequestException(
      'BACKGROUND_JOBS_BAD_CURSOR',
      `not a background jobs cursor: ${cursor}`,
    );
  }
  return { startedAt, id };
}

import type { Observable } from 'rxjs';
import { z } from 'zod';

/** Every kind of work geniro does in the background on the user's behalf. */
export const BACKGROUND_JOB_KINDS = ['lessons'] as const;
export type BackgroundJobKind = (typeof BACKGROUND_JOB_KINDS)[number];

export const BACKGROUND_JOB_STATUSES = [
  'queued',
  'running',
  'done',
  'failed',
] as const;
export type BackgroundJobStatus = (typeof BACKGROUND_JOB_STATUSES)[number];

export const BACKGROUND_JOBS_PAGE_DEFAULT = 20;
export const BACKGROUND_JOBS_PAGE_MAX = 100;

export const BackgroundJobLessonsSchema = z
  .object({
    saved: z
      .number()
      .int()
      .min(0)
      .describe('Lessons saved into memory, active and found by agents'),
    waiting: z
      .number()
      .int()
      .min(0)
      .describe(
        'Lessons that wait for the user: proposed, a failed check, or saved into memory pending review',
      ),
    dropped: z
      .number()
      .int()
      .min(0)
      .describe('Lessons the check dropped or that memory already held'),
  })
  .meta({ id: 'BackgroundJobLessons' });
export type BackgroundJobLessons = z.infer<typeof BackgroundJobLessonsSchema>;

export const BackgroundJobSchema = z
  .object({
    id: z.string(),
    kind: z.enum(BACKGROUND_JOB_KINDS),
    status: z.enum(BACKGROUND_JOB_STATUSES),
    phase: z
      .string()
      .nullable()
      .describe('What a running job is doing now, in the kind’s own words'),
    runId: z
      .string()
      .nullable()
      .describe('The thread the job works for, which a press opens'),
    title: z.string().nullable().describe('That thread’s title'),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    model: z.string().nullable(),
    costUsd: z
      .number()
      .nullable()
      .describe('What the job cost; null when nothing reported a cost'),
    durationMs: z
      .number()
      .nullable()
      .describe('How long the job worked; null when nothing reported a time'),
    error: z.string().nullable().describe('Why a failed job failed'),
    lessons: BackgroundJobLessonsSchema.nullable().describe(
      'What a finished lessons job filed; null for another kind or one not finished',
    ),
  })
  .meta({ id: 'BackgroundJob' });
export type BackgroundJob = z.infer<typeof BackgroundJobSchema>;

export const BackgroundJobListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(BACKGROUND_JOBS_PAGE_MAX)
    .default(BACKGROUND_JOBS_PAGE_DEFAULT),
  before: z
    .string()
    .max(400)
    .optional()
    .describe('The `nextBefore` of the previous page'),
});
export type BackgroundJobListQuery = z.infer<
  typeof BackgroundJobListQuerySchema
>;

export const BackgroundJobListSchema = z
  .object({
    active: z
      .array(BackgroundJobSchema)
      .describe('Every queued and running job, running first'),
    finished: z
      .array(BackgroundJobSchema)
      .describe('One page of finished jobs, newest first'),
    nextBefore: z
      .string()
      .nullable()
      .describe(
        'The cursor of the next page of finished jobs; null at the end',
      ),
    running: z
      .number()
      .int()
      .min(0)
      .describe('How many jobs are queued or running'),
  })
  .meta({ id: 'BackgroundJobList' });
export type BackgroundJobList = z.infer<typeof BackgroundJobListSchema>;

/**
 * A `background_jobs_changed` broadcast: a job of this kind started, moved or ended.
 *
 * TWIN PARSER: apps/ui/src/renderer/daemon-client.ts `parseBackgroundJobsChanged`.
 */
export interface BackgroundJobsChangedEvent {
  kind: BackgroundJobKind;
}

/**
 * One kind of background work, as the registry reads it. `finished` answers
 * up to `limit` jobs started no later than `notAfter`, newest first; the
 * registry cuts the page and its cursor across every source.
 */
export interface BackgroundJobSource {
  readonly kind: BackgroundJobKind;
  active(): Promise<BackgroundJob[]>;
  finished(page: {
    notAfter: Date | null;
    limit: number;
  }): Promise<BackgroundJob[]>;
  changes(): Observable<unknown>;
}

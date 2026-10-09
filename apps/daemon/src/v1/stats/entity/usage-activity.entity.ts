import { randomUUID } from 'node:crypto';

import { DateTimeType } from '@mikro-orm/core';
import {
  Entity,
  Index,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { UsageActivityKind } from '../stats.types';

/**
 * One fact about what the app's threads did, recorded to OUTLIVE the thread.
 *
 * The same lifetime argument as `UsageEvent`: `RunTeardownService` deletes a run's
 * rows, so a count read from `runs` or from the transcript shrinks whenever someone
 * tidies a chat away. Nothing here is written by the teardown. Three kinds share the
 * table, told apart by `kind`:
 *
 * - `thread`: a run was created. One row per run.
 * - `pull_request`: a pull request a thread OPENED, from its `gh pr create` result.
 *   One row per run and pull request.
 * - `lines`: one CUMULATIVE snapshot of the thread's own change totals against its
 *   start commit, taken after a finished turn. Many per run. A day's figure is the
 *   growth between consecutive snapshots, so a snapshot missed while the app was
 *   closed moves the timing of that growth but not its total.
 *
 * Every figure is nullable, and null means NOT MEASURED rather than zero: a snapshot
 * whose changes could not be counted is simply not written.
 */
@Entity({ tableName: 'usage_activity' })
// The idempotency key. A thread and a pull request happen once, so the database
// refuses a second row for either. A lines snapshot gets a fresh key and is never
// refused: a thread is measured many times over its life.
@Unique({ properties: ['dedupKey'] })
// The page's range predicate: this kind, this period.
@Index({ properties: ['kind', 'occurredAt'] })
// The per-thread baseline: a thread's last snapshot before a period starts.
@Index({ properties: ['runId', 'kind', 'occurredAt'] })
export class UsageActivity extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  kind!: UsageActivityKind;

  /** The thread this fact belongs to. A plain string with no FK, like `UsageEvent.runId`. */
  @Property({ type: 'string' })
  runId!: string;

  /** When the fact happened: the run's creation, the pull request's transcript row, or the snapshot's turn. */
  @Property({ type: DateTimeType })
  occurredAt!: Date;

  /** `thread:<runId>`, `pr:<runId>:<owner>/<repo>#<number>`, or `lines:<uuid>`. */
  @Property({ type: 'string' })
  dedupKey!: string;

  /** A pull request's identity. Null for every other kind. */
  @Property({ type: 'string', nullable: true })
  prOwner: string | null = null;

  @Property({ type: 'string', nullable: true })
  prRepo: string | null = null;

  @Property({ type: 'integer', nullable: true })
  prNumber: number | null = null;

  @Property({ type: 'text', nullable: true })
  prUrl: string | null = null;

  /** A lines snapshot's cumulative totals. Null for every other kind. */
  @Property({ type: 'integer', nullable: true })
  linesAdded: number | null = null;

  @Property({ type: 'integer', nullable: true })
  linesRemoved: number | null = null;

  /** Whether a lines snapshot is a lower bound: a truncated listing, or untracked files the count did not read. */
  @Property({ type: 'boolean', nullable: true })
  partial: boolean | null = null;
}

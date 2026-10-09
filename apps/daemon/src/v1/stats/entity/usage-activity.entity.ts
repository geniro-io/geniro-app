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
 * - `lines`: one CUMULATIVE snapshot of a folder's change totals against the folder's
 *   baseline commit (`LineBaseline`), taken after one of its threads finished a turn.
 *   Many per folder. A day's figure is the growth past the highest total its line key
 *   had reached, so a snapshot missed while the app was closed moves the timing of that
 *   growth but not its total, and a total that falls back and rises again counts its
 *   lines once.
 *
 * Every figure is nullable, and null means NOT MEASURED rather than zero: a snapshot
 * whose changes could not be counted is simply not written.
 */
@Entity({ tableName: 'usage_activity' })
// The idempotency key. A thread and a pull request happen once, so the database
// refuses a second row for either. A lines snapshot gets a fresh key and is never
// refused: a folder is measured many times over its life.
@Unique({ properties: ['dedupKey'] })
// The page's range predicate: this kind, this period.
@Index({ properties: ['kind', 'occurredAt'] })
// A row written before baselines existed: its thread's highest total before a period starts.
@Index({ properties: ['runId', 'kind', 'occurredAt'] })
// A line key's highest total before a period starts.
@Index({ properties: ['lineKey', 'kind', 'occurredAt'] })
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

  /**
   * Which series a lines snapshot belongs to: its folder, branch and baseline, hashed
   * (`lineKeyOf`). Stamped at write time, because the run that supplied the folder can be
   * deleted while the ledger stays. Null for every other kind, and for a lines row written
   * before baselines existed, which is counted per thread instead.
   */
  @Property({ type: 'string', nullable: true })
  lineKey: string | null = null;

  /** A lines snapshot's cumulative totals. Null for every other kind. */
  @Property({ type: 'integer', nullable: true })
  linesAdded: number | null = null;

  @Property({ type: 'integer', nullable: true })
  linesRemoved: number | null = null;

  /** Whether a lines snapshot is a lower bound: a truncated listing, or untracked files the count did not read. */
  @Property({ type: 'boolean', nullable: true })
  partial: boolean | null = null;
}

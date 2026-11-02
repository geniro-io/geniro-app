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

import type {
  RunOutcomeAcceptance,
  StageChangeAction,
  ThreadOutcomeKind,
} from '../../agents/chat.types';
import type { UsageActivityKind } from '../stats.types';

/**
 * One fact about what the app's threads did, recorded to OUTLIVE the thread.
 *
 * The same lifetime argument as `UsageEvent`: `RunTeardownService` deletes a run's
 * rows, so a count read from `runs` or from the transcript shrinks whenever someone
 * tidies a chat away. Nothing here is written by the teardown. Four kinds share the
 * table, told apart by `kind`:
 *
 * - `thread`: a run was created. One row per run. A team run's row also carries
 *   the team ledger's version stamp (`teamSlug`, `teamVersion`,
 *   `teamVersionInferred`), written in place when the run is created.
 * - `pull_request`: a pull request a thread OPENED, from its `gh pr create` result.
 *   One row per run and pull request.
 * - `lines`: one CUMULATIVE snapshot of a folder's change totals against the folder's
 *   baseline commit (`LineBaseline`), taken after one of its threads finished a turn.
 *   Many per folder. A day's figure is the growth past the highest total its line key
 *   had reached, so a snapshot missed while the app was closed moves the timing of that
 *   growth but not its total, and a total that falls back and rises again counts its
 *   lines once.
 * - `run_outcome`: one pull request's newest recorded outcome (`record_outcome`), copied
 *   from the run's `run_outcome` items. One row per run and pull request, UPDATED to a
 *   newer outcome, and only ever forward (`sourceSeq`).
 * - `thread_outcome`: how the thread ended, as its newest `thread_outcome` item says.
 *   One row per run, UPDATED forward like `run_outcome`.
 * - `stage`: one stage change of a team run (`stage_change` items): a move, or a
 *   hand-off of the lead. One row per change.
 * - `call`: one agent-to-agent call that ended (`call_result` items), with its caller,
 *   callee, the callee's turns and spend inside it, and whether it answered. One row per
 *   call.
 *
 * Every figure is nullable, and null means NOT MEASURED rather than zero: a snapshot
 * whose changes could not be counted is simply not written.
 */
@Entity({ tableName: 'usage_activity' })
// The idempotency key. A thread and a pull request happen once, so the database
// refuses a second row for either; an outcome's row, and a team run's version
// stamp, are updated in place under their key. A lines snapshot gets a fresh key
// and is never refused: a folder is measured many times over its life.
@Unique({ properties: ['dedupKey'] })
// The page's range predicate: this kind, this period.
@Index({ properties: ['kind', 'occurredAt'] })
// A row written before baselines existed: its thread's highest total before a period starts.
@Index({ properties: ['runId', 'kind', 'occurredAt'] })
// A line key's highest total before a period starts.
@Index({ properties: ['lineKey', 'kind', 'occurredAt'] })
// One team's thread rows, for its versions table.
@Index({ properties: ['teamSlug', 'kind'] })
// One team's stage, call and outcome rows over a period.
@Index({ properties: ['teamSlug', 'kind', 'occurredAt'] })
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

  /**
   * `thread:<runId>`, `pr:<runId>:<owner>/<repo>#<number>`,
   * `outcome:<runId>:<owner>/<repo>#<number>`, or `lines:<uuid>`.
   */
  @Property({ type: 'string' })
  dedupKey!: string;

  /** A pull request's identity, on a `pull_request` or `run_outcome` row. Null for every other kind. */
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

  /**
   * The team the run ran, on a `run_outcome` row and on a team run's `thread`
   * row. Stamped at write time, like `lineKey`, because the run can be deleted while
   * the ledger stays. Null for a chat's thread and every other kind.
   */
  @Property({ type: 'string', nullable: true })
  teamSlug: string | null = null;

  /** The `run_outcome` item an outcome row was copied from; a copy only moves forward. */
  @Property({ type: 'integer', nullable: true })
  sourceSeq: number | null = null;

  /** An outcome row's figures (`RunOutcomePayload`). Null for every other kind. */
  @Property({ type: 'boolean', nullable: true })
  outcomeDraft: boolean | null = null;

  @Property({ type: 'integer', nullable: true })
  outcomeReviewRounds: number | null = null;

  @Property({ type: 'string', nullable: true })
  outcomeAcceptance: RunOutcomeAcceptance | null = null;

  @Property({ type: 'integer', nullable: true })
  outcomeQuestionsAsked: number | null = null;

  /** Times the pull request went to `changes_requested` over every outcome the run recorded for it; null until counted. */
  @Property({ type: 'integer', nullable: true })
  outcomeChangesRequestedRounds: number | null = null;

  /** From the pull request's first outcome to its first `accepted`; null while never accepted, or not counted yet. */
  @Property({ type: 'integer', nullable: true })
  outcomeMsToAccepted: number | null = null;

  /** `teamVersionOf` the run's own team copy; null while unstamped, and for a run that kept no copy it can read. */
  @Property({ type: 'string', nullable: true })
  teamVersion: string | null = null;

  /** The version was hashed from a copy frozen AFTER the run started, so it may not be the team the run had. */
  @Property({ type: 'boolean', nullable: true })
  teamVersionInferred: boolean | null = null;

  /** A `stage` row's mover, when an agent moved it; a `call` row's caller. */
  @Property({ type: 'string', nullable: true })
  memberId: string | null = null;

  /** A `call` row's callee; a `stage` hand-off's new lead. */
  @Property({ type: 'string', nullable: true })
  peerMemberId: string | null = null;

  @Property({ type: 'string', nullable: true })
  stageId: string | null = null;

  @Property({ type: 'string', nullable: true })
  stageAction: StageChangeAction | null = null;

  /** When the stage a `complete` row closes became current. */
  @Property({ type: DateTimeType, nullable: true })
  enteredAt: Date | null = null;

  /** A completed stage's time as current; a call's time from start to answer. */
  @Property({ type: 'integer', nullable: true })
  durationMs: number | null = null;

  /** What the callee's turns inside a call cost, as their CLIs reported; null when none did. */
  @Property({ type: 'float', nullable: true })
  costUsd: number | null = null;

  /** The callee's finished turns inside a call. */
  @Property({ type: 'integer', nullable: true })
  turns: number | null = null;

  /** Whether a call answered rather than failing or being cancelled. */
  @Property({ type: 'boolean', nullable: true })
  ok: boolean | null = null;

  @Property({ type: 'string', nullable: true })
  outcomeKind: ThreadOutcomeKind | null = null;

  /**
   * A `thread` row of a run this build's metric ledgers watched from its creation
   * (tool calls, stages, calls). A run without it reads "not measured" for those.
   */
  @Property({ type: 'boolean', nullable: true })
  metricsLedger: boolean | null = null;
}

import { randomUUID } from 'node:crypto';

import {
  EntityManager,
  UniqueConstraintViolationException,
} from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';
import type { ExpressionBuilder } from 'kysely';

import { idBatches } from '../../agents/utils/id-batches';
import { UsageActivity } from '../entity/usage-activity.entity';
import type {
  ActivityFact,
  LineSnapshotRow,
  LinesPeak,
  PullRequestActivityInput,
  RunOutcomeLedgerRow,
  ThreadLedgerRow,
  ThreadVersionStamp,
  UsageActivityKind,
} from '../stats.types';
import {
  pullRequestFact,
  runOutcomeKey,
  threadFact,
} from '../utils/activity-facts';
import { LEGACY_LINE_KEY_PREFIX } from '../utils/line-keys';

function flagOf(value: number | null): boolean | null {
  return value === null ? null : value !== 0;
}

const LEDGER_COLUMNS = [
  'run_id',
  'occurred_at',
  'workflow_slug',
  'workflow_version',
  'workflow_version_inferred',
] as const;

type LedgerColumns = Pick<
  ActivityDatabase['usage_activity'],
  (typeof LEDGER_COLUMNS)[number]
>;

function toLedgerRow(row: LedgerColumns): ThreadLedgerRow {
  return {
    runId: row.run_id,
    occurredAt: new Date(Number(row.occurred_at)),
    slug: row.workflow_slug,
    version: row.workflow_version,
    inferred: flagOf(row.workflow_version_inferred),
  };
}

/**
 * `usage_activity` as SQLite stores it, for the typed Kysely reads and writes — typed off
 * the entity, so a renamed or retyped field fails the build. Dates are the stored epoch
 * milliseconds and booleans the stored 0/1, since value conversion is off.
 */
interface ActivityDatabase {
  usage_activity: {
    id: UsageActivity['id'];
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
    kind: UsageActivity['kind'];
    run_id: UsageActivity['runId'];
    occurred_at: number;
    dedup_key: UsageActivity['dedupKey'];
    pr_owner: UsageActivity['prOwner'];
    pr_repo: UsageActivity['prRepo'];
    pr_number: UsageActivity['prNumber'];
    pr_url: UsageActivity['prUrl'];
    line_key: UsageActivity['lineKey'];
    lines_added: UsageActivity['linesAdded'];
    lines_removed: UsageActivity['linesRemoved'];
    partial: number | null;
    workflow_slug: UsageActivity['workflowSlug'];
    source_seq: UsageActivity['sourceSeq'];
    outcome_draft: number | null;
    outcome_review_rounds: UsageActivity['outcomeReviewRounds'];
    outcome_acceptance: UsageActivity['outcomeAcceptance'];
    outcome_questions_asked: UsageActivity['outcomeQuestionsAsked'];
    outcome_changes_requested_rounds: UsageActivity['outcomeChangesRequestedRounds'];
    outcome_ms_to_accepted: UsageActivity['outcomeMsToAccepted'];
    workflow_version: UsageActivity['workflowVersion'];
    workflow_version_inferred: number | null;
  };
}

/**
 * `snapshotLineKey` in the database, for a read that groups rows by series. Built from the
 * same prefix, so the database and the fold cannot file one row under two keys.
 */
function seriesKeyOf(
  eb: ExpressionBuilder<ActivityDatabase, 'usage_activity'>,
) {
  return eb.fn<string>('coalesce', [
    eb.ref('line_key'),
    eb(eb.val(LEGACY_LINE_KEY_PREFIX), '||', eb.ref('run_id')),
  ]);
}

/**
 * The durable record of what threads did (see the entity). The two facts that happen
 * once are written idempotently, so a boot sweep can re-run over history and the
 * database refuses a duplicate rather than relying on every caller to check first.
 */
@Injectable()
export class UsageActivityDao extends BaseDao<UsageActivity> {
  constructor(em: EntityManager) {
    super(em, UsageActivity);
  }

  /**
   * Record that a run was created, or do nothing if that is already recorded.
   *
   * @returns true when a row was written.
   */
  async insertThreadOnce(
    runId: string,
    occurredAt: Date,
    txEm?: EntityManager,
  ): Promise<boolean> {
    return this.insertOnce(threadFact(runId, occurredAt), txEm);
  }

  /**
   * Record a pull request a thread opened, or do nothing if that thread already
   * recorded it.
   *
   * @returns true when a row was written.
   */
  async insertPullRequestOnce(
    input: PullRequestActivityInput,
    txEm?: EntityManager,
  ): Promise<boolean> {
    return this.insertOnce(pullRequestFact(input), txEm);
  }

  /**
   * Write every fact the ledger does not already hold, for a sweep over the whole history:
   * the recorded keys are read ONCE, and the missing rows are written in one transaction.
   * A lookup per fact would cost a query per run on every launch to learn that nothing is
   * missing. A writer that takes a key in between is refused by the unique index, and that
   * fact counts as already recorded.
   *
   * @returns how many rows of each kind were written.
   */
  async insertMissing(
    facts: readonly ActivityFact[],
    txEm?: EntityManager,
  ): Promise<Record<ActivityFact['kind'], number>> {
    const written: Record<ActivityFact['kind'], number> = {
      thread: 0,
      pull_request: 0,
    };
    if (facts.length === 0) {
      return written;
    }
    const kinds = [...new Set(facts.map((fact) => fact.kind))];
    const known = new Set(
      (
        await this.getRepo(txEm).find(
          { kind: { $in: kinds } },
          { fields: ['dedupKey'], disableIdentityMap: true },
        )
      ).map((row) => row.dedupKey),
    );
    const missing = facts.filter((fact) => !known.has(fact.dedupKey));
    if (missing.length === 0) {
      return written;
    }
    await (txEm ?? this.em).transactional(async (tx) => {
      for (const fact of missing) {
        if (await this.insertFact(fact, tx)) {
          written[fact.kind] += 1;
        }
      }
    });
    return written;
  }

  /**
   * Record one pull request's outcome on one run, or move its row forward to this one.
   * A row already holding a newer outcome (a higher `sourceSeq`) is left as it is: the
   * live copy and the boot sweep can reach one pull request out of order, and neither
   * may move an outcome backwards. A row at the same seq is rewritten only while it lacks
   * the history figures (written before they were counted), so the sweep can fill them in.
   * One statement, so two copies racing land in seq order whichever arrives first.
   */
  async upsertRunOutcome(
    row: RunOutcomeLedgerRow,
    txEm?: EntityManager,
  ): Promise<void> {
    const now = Date.now();
    await (txEm ?? this.em.fork())
      .getKysely<ActivityDatabase>({ convertValues: false })
      .insertInto('usage_activity')
      .values({
        id: randomUUID(),
        created_at: now,
        updated_at: now,
        deleted_at: null,
        kind: 'run_outcome',
        run_id: row.runId,
        occurred_at: row.occurredAt.getTime(),
        dedup_key: runOutcomeKey(row),
        pr_owner: row.prOwner,
        pr_repo: row.prRepo,
        pr_number: row.prNumber,
        pr_url: row.prUrl,
        workflow_slug: row.workflowSlug,
        source_seq: row.sourceSeq,
        outcome_draft: row.draft ? 1 : 0,
        outcome_review_rounds: row.reviewRounds,
        outcome_acceptance: row.acceptance,
        outcome_questions_asked: row.questionsAsked,
        outcome_changes_requested_rounds: row.changesRequestedRounds,
        outcome_ms_to_accepted: row.msToAccepted,
      })
      .onConflict((conflict) =>
        conflict
          .column('dedup_key')
          .doUpdateSet((eb) => ({
            updated_at: now,
            occurred_at: eb.ref('excluded.occurred_at'),
            pr_url: eb.ref('excluded.pr_url'),
            workflow_slug: eb.ref('excluded.workflow_slug'),
            source_seq: eb.ref('excluded.source_seq'),
            outcome_draft: eb.ref('excluded.outcome_draft'),
            outcome_review_rounds: eb.ref('excluded.outcome_review_rounds'),
            outcome_acceptance: eb.ref('excluded.outcome_acceptance'),
            outcome_questions_asked: eb.ref('excluded.outcome_questions_asked'),
            outcome_changes_requested_rounds: eb.ref(
              'excluded.outcome_changes_requested_rounds',
            ),
            outcome_ms_to_accepted: eb.ref('excluded.outcome_ms_to_accepted'),
          }))
          .where((eb) =>
            eb.or([
              eb('usage_activity.source_seq', 'is', null),
              eb(
                'usage_activity.source_seq',
                '<',
                eb.ref('excluded.source_seq'),
              ),
              eb.and([
                eb(
                  'usage_activity.source_seq',
                  '=',
                  eb.ref('excluded.source_seq'),
                ),
                eb(
                  'usage_activity.outcome_changes_requested_rounds',
                  'is',
                  null,
                ),
              ]),
            ]),
          ),
      )
      .execute();
  }

  /**
   * The outcomes the ledger holds — one per run and pull request, its newest — for the
   * given runs, or every run of one workflow. What a per-version outcome fold reads, and it
   * reads it here rather than from the transcript because a deleted run's rows are gone.
   */
  async runOutcomes(
    filter: { runIds?: readonly string[]; workflowSlug?: string },
    txEm?: EntityManager,
  ): Promise<RunOutcomeLedgerRow[]> {
    if (filter.runIds !== undefined && filter.runIds.length === 0) {
      return [];
    }
    const rows = await this.getRepo(txEm).find(
      {
        kind: 'run_outcome',
        ...(filter.runIds === undefined
          ? {}
          : { runId: { $in: [...filter.runIds] } }),
        ...(filter.workflowSlug === undefined
          ? {}
          : { workflowSlug: filter.workflowSlug }),
      },
      { orderBy: { occurredAt: 'asc' }, disableIdentityMap: true },
    );
    const outcomes: RunOutcomeLedgerRow[] = [];
    for (const row of rows) {
      if (
        row.sourceSeq === null ||
        row.prOwner === null ||
        row.prRepo === null ||
        row.prNumber === null ||
        row.prUrl === null ||
        row.outcomeDraft === null ||
        row.outcomeReviewRounds === null ||
        row.outcomeAcceptance === null ||
        row.outcomeQuestionsAsked === null
      ) {
        continue;
      }
      outcomes.push({
        runId: row.runId,
        sourceSeq: row.sourceSeq,
        occurredAt: row.occurredAt,
        workflowSlug: row.workflowSlug,
        prOwner: row.prOwner,
        prRepo: row.prRepo,
        prNumber: row.prNumber,
        prUrl: row.prUrl,
        draft: row.outcomeDraft,
        reviewRounds: row.outcomeReviewRounds,
        acceptance: row.outcomeAcceptance,
        questionsAsked: row.outcomeQuestionsAsked,
        changesRequestedRounds: row.outcomeChangesRequestedRounds,
        msToAccepted: row.outcomeMsToAccepted,
      });
    }
    return outcomes;
  }

  /**
   * Each recorded outcome's `sourceSeq` and whether its history figures were counted, by
   * ledger key — what the boot sweep compares a run's newest outcome item against, read
   * once rather than per pull request.
   */
  async runOutcomeCopies(
    txEm?: EntityManager,
  ): Promise<Map<string, { sourceSeq: number; counted: boolean }>> {
    const rows = await this.getRepo(txEm).find(
      { kind: 'run_outcome' },
      {
        fields: ['dedupKey', 'sourceSeq', 'outcomeChangesRequestedRounds'],
        disableIdentityMap: true,
      },
    );
    const copies = new Map<string, { sourceSeq: number; counted: boolean }>();
    for (const row of rows) {
      if (row.sourceSeq !== null) {
        copies.set(row.dedupKey, {
          sourceSeq: row.sourceSeq,
          counted: row.outcomeChangesRequestedRounds !== null,
        });
      }
    }
    return copies;
  }

  /** Record one cumulative lines snapshot. Never refused, since a thread is measured many times. */
  async insertLineSnapshot(
    input: LineSnapshotRow,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).insert(
      Object.assign(new UsageActivity(), {
        kind: 'lines' as const,
        runId: input.runId,
        lineKey: input.lineKey,
        occurredAt: input.occurredAt,
        // The column is NOT NULL and unique, so a lines row takes a fresh key. Nothing
        // dedups on it.
        dedupKey: `lines:${randomUUID()}`,
        linesAdded: input.linesAdded,
        linesRemoved: input.linesRemoved,
        partial: input.partial,
      }),
    );
  }

  /**
   * Every fact of one kind recorded in a period, oldest first. The range is half-open,
   * which is what lets adjacent days share a boundary without counting a fact twice.
   */
  async inRange(
    kind: UsageActivityKind,
    from: Date,
    to: Date,
    fields: readonly (keyof UsageActivity & string)[],
    txEm?: EntityManager,
  ): Promise<UsageActivity[]> {
    return this.getRepo(txEm).find(
      { kind, occurredAt: { $gte: from, $lt: to } },
      {
        // The stats page reads this on every recorded turn, so it loads only what it folds.
        fields: [...fields],
        orderBy: { occurredAt: 'asc' },
        disableIdentityMap: true,
      },
    );
  }

  /**
   * The earliest row of the given kinds. The stats floor asks for threads and pull requests
   * only: a lines snapshot is dated by the desktop app, so counting it would let a client
   * move the floor (see `StatsService.recordLinesSnapshot`).
   */
  async earliestOccurredAt(
    kinds: readonly UsageActivityKind[],
    txEm?: EntityManager,
  ): Promise<Date | null> {
    const row = await this.getRepo(txEm).findOne(
      { kind: { $in: [...kinds] } },
      { orderBy: { occurredAt: 'asc' }, disableIdentityMap: true },
    );
    return row?.occurredAt ?? null;
  }

  /**
   * The highest lines total each series reached BEFORE a period starts, per count: the
   * baseline the period's growth is counted past. Keyed like `snapshotLineKey`. A series
   * absent from the map has no earlier snapshot, so its whole total in the period counts
   * as growth.
   *
   * One grouped statement for every series together, the peak taken in the database. A
   * series' history is every snapshot ever taken of it, and it grows with how often it was
   * measured, so reading the rows to find the highest one would cost more on every stats
   * request as the history did. A row with either count unmeasured is left out whole, as
   * the growth fold leaves it out.
   */
  async peakLinesBefore(
    series: readonly { runId: string; lineKey: string | null }[],
    before: Date,
    txEm?: EntityManager,
  ): Promise<Map<string, LinesPeak>> {
    const peaks = new Map<string, LinesPeak>();
    const lineKeys = new Set<string>();
    const legacyRunIds = new Set<string>();
    for (const row of series) {
      if (row.lineKey === null) {
        legacyRunIds.add(row.runId);
      } else {
        lineKeys.add(row.lineKey);
      }
    }
    if (lineKeys.size === 0 && legacyRunIds.size === 0) {
      return peaks;
    }
    const rows = await (txEm ?? this.em.fork())
      .getKysely<ActivityDatabase>({ convertValues: false })
      .selectFrom('usage_activity')
      .select((eb) => [
        // The same key `snapshotLineKey` gives a row, so the two maps cannot disagree.
        seriesKeyOf(eb).as('series_key'),
        eb.fn.max<number>('lines_added').as('lines_added'),
        eb.fn.max<number>('lines_removed').as('lines_removed'),
      ])
      .where('kind', '=', 'lines')
      .where('occurred_at', '<', before.getTime())
      .where('lines_added', 'is not', null)
      .where('lines_removed', 'is not', null)
      .where('deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          ...(lineKeys.size > 0 ? [eb('line_key', 'in', [...lineKeys])] : []),
          ...(legacyRunIds.size > 0
            ? [
                eb.and([
                  eb('line_key', 'is', null),
                  eb('run_id', 'in', [...legacyRunIds]),
                ]),
              ]
            : []),
        ]),
      )
      .groupBy((eb) => [seriesKeyOf(eb)])
      .execute();
    for (const row of rows) {
      peaks.set(row.series_key, {
        linesAdded: row.lines_added,
        linesRemoved: row.lines_removed,
      });
    }
    return peaks;
  }

  /**
   * Stamp a workflow run's thread row with its workflow and graph version, writing the row
   * first when the recorder has not yet. Both writers insert through the unique key, so
   * either may go first.
   */
  async stampThreadVersion(
    runId: string,
    createdAt: Date,
    stamp: ThreadVersionStamp,
    txEm?: EntityManager,
  ): Promise<void> {
    const em = txEm ?? this.em.fork();
    await this.insertThreadOnce(runId, createdAt, em);
    await em
      .getKysely<ActivityDatabase>({ convertValues: false })
      .updateTable('usage_activity')
      .set({
        workflow_slug: stamp.slug,
        workflow_version: stamp.version,
        workflow_version_inferred:
          stamp.inferred === null ? null : stamp.inferred ? 1 : 0,
        updated_at: Date.now(),
      })
      .where('dedup_key', '=', threadFact(runId, createdAt).dedupKey)
      .execute();
  }

  /** Every thread row stamped with this workflow — its runs, deleted ones included. */
  async threadRowsBySlug(
    slug: string,
    txEm?: EntityManager,
  ): Promise<ThreadLedgerRow[]> {
    const rows = await (txEm ?? this.em.fork())
      .getKysely<ActivityDatabase>({ convertValues: false })
      .selectFrom('usage_activity')
      .select(LEDGER_COLUMNS)
      .where('kind', '=', 'thread')
      .where('workflow_slug', '=', slug)
      .where('deleted_at', 'is', null)
      .execute();
    return rows.map(toLedgerRow);
  }

  /** These runs' thread rows, by run id; a run with no row is absent. */
  async threadRowsByRuns(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<Map<string, ThreadLedgerRow>> {
    const db = (txEm ?? this.em.fork()).getKysely<ActivityDatabase>({
      convertValues: false,
    });
    const out = new Map<string, ThreadLedgerRow>();
    for (const batch of idBatches(runIds)) {
      const rows = await db
        .selectFrom('usage_activity')
        .select(LEDGER_COLUMNS)
        .where('kind', '=', 'thread')
        .where('run_id', 'in', batch)
        .where('deleted_at', 'is', null)
        .execute();
      for (const row of rows) {
        out.set(row.run_id, toLedgerRow(row));
      }
    }
    return out;
  }

  /**
   * Write one fact unless its key is already recorded. A writer that takes the key between
   * the lookup and this insert is refused by the unique index on `dedupKey`, and that refusal
   * answers the same question the lookup did: the fact is already recorded. It is not thrown
   * into a sweep, which would abort on the first such race.
   */
  private async insertOnce(
    fact: ActivityFact,
    txEm?: EntityManager,
  ): Promise<boolean> {
    const existing = await this.getRepo(txEm).findOne(
      { dedupKey: fact.dedupKey },
      { fields: ['id'], disableIdentityMap: true },
    );
    if (existing) {
      return false;
    }
    return this.insertFact(fact, txEm);
  }

  /** Insert one fact; a key another writer already took answers false rather than throwing. */
  private async insertFact(
    fact: ActivityFact,
    txEm?: EntityManager,
  ): Promise<boolean> {
    try {
      await this.getRepo(txEm).insert(Object.assign(new UsageActivity(), fact));
    } catch (err) {
      if (err instanceof UniqueConstraintViolationException) {
        return false;
      }
      throw err;
    }
    return true;
  }
}
